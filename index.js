const DEFAULTS = {
  // OFF-biased for Tequila Mockingbird house bank (electrical.batteries.277):
  // idle current is about -1.4 A. Threshold 8 A keeps that clearly stopped
  // until engine-ON samples are used to tighten the setting.
  observe_path: 'electrical.batteries.277.current',
  threshold: 8,
  polarity: 'negative',
  output_path: 'propulsion.main.state',
  hysteresis: 1,
  holdoff_ms: 1500,
  use_chargingmode: false,
  chargingmodePath: 'electrical.chargers.alternator.chargingMode',
};

const POLARITIES = ['positive', 'negative', 'absolute'];

function finiteNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function resolveOptions(options = {}) {
  const polarity = POLARITIES.includes(options.polarity)
    ? options.polarity
    : DEFAULTS.polarity;
  const threshold = Math.abs(finiteNumber(options.threshold, DEFAULTS.threshold));
  let hysteresis = finiteNumber(options.hysteresis, DEFAULTS.hysteresis);
  if (hysteresis < 0) {
    hysteresis = 0;
  }
  hysteresis = Math.min(hysteresis, threshold);

  return {
    observe_path: options.observe_path || DEFAULTS.observe_path,
    threshold,
    polarity,
    output_path: options.output_path || options.engine_path || DEFAULTS.output_path,
    hysteresis,
    holdoff_ms: Math.max(0, finiteNumber(options.holdoff_ms, DEFAULTS.holdoff_ms)),
    use_chargingmode: Boolean(options.use_chargingmode),
    chargingmodePath: options.chargingmodePath || DEFAULTS.chargingmodePath,
  };
}

function toFiniteNumber(value) {
  return finiteNumber(value, null);
}

// Returns whether the engine should be considered started given the latest
// sample. Invalid values leave the previous state unchanged (OFF if none).
function isEngineStarted(value, options, currentlyStarted) {
  const sample = toFiniteNumber(value);
  if (sample === null) {
    return currentlyStarted === true;
  }

  const { threshold, polarity, hysteresis } = options;
  const stopThreshold = threshold - hysteresis;
  const started = currentlyStarted === true;

  if (polarity === 'negative') {
    if (started) {
      return sample < -stopThreshold;
    }
    return sample < -threshold;
  }

  if (polarity === 'absolute') {
    const magnitude = Math.abs(sample);
    if (started) {
      return magnitude > stopThreshold;
    }
    return magnitude > threshold;
  }

  if (started) {
    return sample > stopThreshold;
  }
  return sample > threshold;
}

function chargingModeStarted(value) {
  if (value == null) {
    return null;
  }
  if (value === 'off' || value === 'OFF') {
    return false;
  }
  return true;
}

module.exports = (app) => {
  const plugin = {};
  let unsubscribes = [];
  let holdoffTimer = null;

  plugin.id = 'signalk-electrical-engine-on';
  plugin.name = 'Electrical engine status detector';
  plugin.description = 'Publishes propulsion started/stopped from electrical current or power';
  const setStatus = app.setPluginStatus || app.setProviderStatus;

  plugin.start = (options) => {
    const opts = resolveOptions(options);
    const subscribePaths = [
      {
        path: opts.observe_path,
        period: 100,
      },
    ];
    if (opts.use_chargingmode) {
      subscribePaths.push({
        path: opts.chargingmodePath,
        period: 100,
      });
    }

    const subscription = {
      context: 'vessels.self',
      subscribe: subscribePaths,
    };

    let publishedState = 'stopped';
    let pendingState = null;

    function clearHoldoff() {
      if (holdoffTimer) {
        clearTimeout(holdoffTimer);
        holdoffTimer = null;
      }
      pendingState = null;
    }

    function setState(state) {
      publishedState = state;
      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            source: {
              label: plugin.id,
            },
            timestamp: (new Date().toISOString()),
            values: [
              {
                path: opts.output_path,
                value: state,
              },
            ],
          },
        ],
      });
      if (setStatus) {
        setStatus(`Detected engine state: ${state}`);
      }
    }

    function consider(state) {
      if (state === publishedState) {
        clearHoldoff();
        return;
      }
      if (state === pendingState) {
        return;
      }
      clearHoldoff();
      pendingState = state;
      if (opts.holdoff_ms <= 0) {
        pendingState = null;
        setState(state);
        return;
      }
      holdoffTimer = setTimeout(() => {
        holdoffTimer = null;
        pendingState = null;
        setState(state);
      }, opts.holdoff_ms);
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error:${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) {
          return;
        }
        delta.updates.forEach((u) => {
          if (!u.values) {
            return;
          }
          u.values.forEach((v) => {
            if (opts.use_chargingmode && v.path === opts.chargingmodePath) {
              const started = chargingModeStarted(v.value);
              if (started == null) {
                return;
              }
              consider(started ? 'started' : 'stopped');
              return;
            }
            if (!opts.use_chargingmode && v.path === opts.observe_path) {
              const currentlyStarted = publishedState === 'started';
              const started = isEngineStarted(v.value, opts, currentlyStarted);
              consider(started ? 'started' : 'stopped');
            }
          });
        });
      },
    );

    // OFF-biased until a qualifying engine-ON sample is held long enough.
    setState('stopped');
  };

  plugin.stop = () => {
    if (holdoffTimer) {
      clearTimeout(holdoffTimer);
      holdoffTimer = null;
    }
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
  };

  plugin.schema = {
    type: 'object',
    properties: {
      observe_path: {
        type: 'string',
        default: DEFAULTS.observe_path,
        title: 'Observe path',
        description: 'Signal K path for current or power used to detect engine-on',
      },
      threshold: {
        type: 'number',
        default: DEFAULTS.threshold,
        title: 'Threshold',
        description: 'Crossed according to polarity to publish started',
      },
      polarity: {
        type: 'string',
        enum: POLARITIES,
        default: DEFAULTS.polarity,
        title: 'Polarity',
        description: 'positive: value > threshold => started; '
          + 'negative: value < -threshold => started; '
          + 'absolute: |value| > threshold => started',
      },
      output_path: {
        type: 'string',
        default: DEFAULTS.output_path,
        title: 'Output path',
        description: 'Signal K path to publish. Values are started or stopped.',
      },
      hysteresis: {
        type: 'number',
        default: DEFAULTS.hysteresis,
        title: 'Hysteresis',
        description: 'Band (same units as threshold) recrossed before leaving started',
      },
      holdoff_ms: {
        type: 'number',
        default: DEFAULTS.holdoff_ms,
        title: 'Hold-off (ms)',
        description: 'Milliseconds a new state must persist before it is published',
      },
      use_chargingmode: {
        type: 'boolean',
        default: DEFAULTS.use_chargingmode,
        title: 'Use charging mode instead of observe path (Orion XS)',
      },
      chargingmodePath: {
        type: 'string',
        default: DEFAULTS.chargingmodePath,
        title: 'Charging mode path (when charging mode is enabled)',
      },
    },
  };

  return plugin;
};

module.exports.DEFAULTS = DEFAULTS;
module.exports.resolveOptions = resolveOptions;
module.exports.isEngineStarted = isEngineStarted;
