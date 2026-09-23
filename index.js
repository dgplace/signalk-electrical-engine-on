const DETECTION_MODES = ['simple', 'compound'];
const POLARITIES = ['positive', 'negative', 'absolute'];

const DEFAULTS = {
  // OFF-biased for Tequila Mockingbird house bank (electrical.batteries.277):
  // idle current is about -1.4 A. Threshold 8 A keeps that clearly stopped
  // until engine-ON samples are used to tighten the setting.
  detection_mode: 'simple',
  observe_path: 'electrical.batteries.277.current',
  threshold: 8,
  polarity: 'negative',
  output_path: 'propulsion.main.state',
  hysteresis: 1,
  holdoff_ms: 1500,
  use_chargingmode: false,
  chargingmodePath: 'electrical.chargers.alternator.chargingMode',
  voltage_path: 'electrical.batteries.277.voltage',
  current_path: 'electrical.batteries.277.current',
  power_path: 'electrical.batteries.277.power',
  // Empty: DC-system clause disabled until set. Venus (signalk-venus-plugin)
  // typically publishes dbus /Dc/System/Power as electrical.{venusName}.dcPower.
  dc_system_path: '',
  // negative: VRM "DC System" (motoring is negative watts). positive: Signal K
  // electrical.venus.dcPower on Tequila Mockingbird (motoring is positive).
  dc_polarity: 'negative',
  on_dc_max: -100,
  hold_dc_max: -50,
  on_voltage_min: 14.0,
  hold_voltage_min: 13.7,
  on_current_min: 10,
  hold_current_min: 5,
  on_power_min: 100,
  hold_power_min: 50,
};

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

function pathOrDefault(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return fallback;
}

function optionalPath(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  return value.trim();
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
  const detectionMode = DETECTION_MODES.includes(options.detection_mode)
    ? options.detection_mode
    : DEFAULTS.detection_mode;
  const dcPolarity = POLARITIES.includes(options.dc_polarity)
    ? options.dc_polarity
    : DEFAULTS.dc_polarity;

  return {
    detection_mode: detectionMode,
    observe_path: options.observe_path || DEFAULTS.observe_path,
    threshold,
    polarity,
    output_path: options.output_path || options.engine_path || DEFAULTS.output_path,
    hysteresis,
    holdoff_ms: Math.max(0, finiteNumber(options.holdoff_ms, DEFAULTS.holdoff_ms)),
    use_chargingmode: Boolean(options.use_chargingmode),
    chargingmodePath: options.chargingmodePath || DEFAULTS.chargingmodePath,
    voltage_path: pathOrDefault(options.voltage_path, DEFAULTS.voltage_path),
    current_path: pathOrDefault(options.current_path, DEFAULTS.current_path),
    power_path: pathOrDefault(options.power_path, DEFAULTS.power_path),
    dc_system_path: optionalPath(options.dc_system_path, DEFAULTS.dc_system_path),
    dc_polarity: dcPolarity,
    on_dc_max: finiteNumber(options.on_dc_max, DEFAULTS.on_dc_max),
    hold_dc_max: finiteNumber(options.hold_dc_max, DEFAULTS.hold_dc_max),
    on_voltage_min: finiteNumber(options.on_voltage_min, DEFAULTS.on_voltage_min),
    hold_voltage_min: finiteNumber(options.hold_voltage_min, DEFAULTS.hold_voltage_min),
    on_current_min: finiteNumber(options.on_current_min, DEFAULTS.on_current_min),
    hold_current_min: finiteNumber(options.hold_current_min, DEFAULTS.hold_current_min),
    on_power_min: finiteNumber(options.on_power_min, DEFAULTS.on_power_min),
    hold_power_min: finiteNumber(options.hold_power_min, DEFAULTS.hold_power_min),
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

// Three-valued OR: true | false | null (unknown / not yet evaluable).
function ternaryOr(left, right) {
  if (left === true || right === true) {
    return true;
  }
  if (left === false && right === false) {
    return false;
  }
  return null;
}

function dcPowerMeets(sample, threshold, polarity) {
  const power = toFiniteNumber(sample);
  if (power === null) {
    return null;
  }
  if (polarity === 'positive') {
    return power >= threshold;
  }
  if (polarity === 'absolute') {
    return Math.abs(power) >= Math.abs(threshold);
  }
  return power <= threshold;
}

function batteryVipMeets(samples, voltageMin, currentMin, powerMin) {
  const voltage = toFiniteNumber(samples.voltage);
  const current = toFiniteNumber(samples.current);
  const power = toFiniteNumber(samples.power);
  if (voltage === null || current === null || power === null) {
    return null;
  }
  return voltage >= voltageMin
    && current >= currentMin
    && power >= powerMin;
}

function compoundClause(samples, options, kind) {
  const isOn = kind === 'on';
  const dcMax = isOn ? options.on_dc_max : options.hold_dc_max;
  const voltageMin = isOn ? options.on_voltage_min : options.hold_voltage_min;
  const currentMin = isOn ? options.on_current_min : options.hold_current_min;
  const powerMin = isOn ? options.on_power_min : options.hold_power_min;
  const dc = options.dc_system_path
    ? dcPowerMeets(samples.dcSystemPower, dcMax, options.dc_polarity)
    : false;
  const vip = batteryVipMeets(samples, voltageMin, currentMin, powerMin);
  return ternaryOr(dc, vip);
}

function compoundOn(samples, options) {
  return compoundClause(samples, options, 'on');
}

function compoundHold(samples, options) {
  return compoundClause(samples, options, 'hold');
}

// State machine: ON only enters started; HOLD false is the only exit.
// Unknown (missing samples) keeps the previous state.
function nextCompoundStarted(samples, options, currentlyStarted) {
  if (currentlyStarted === true) {
    return compoundHold(samples, options) !== false;
  }
  return compoundOn(samples, options) === true;
}

function compoundSampleKey(path, options) {
  if (path === options.voltage_path) {
    return 'voltage';
  }
  if (path === options.current_path) {
    return 'current';
  }
  if (path === options.power_path) {
    return 'power';
  }
  if (options.dc_system_path && path === options.dc_system_path) {
    return 'dcSystemPower';
  }
  return null;
}

function addSubscribePath(paths, path) {
  if (!path) {
    return;
  }
  if (paths.some((entry) => entry.path === path)) {
    return;
  }
  paths.push({
    path,
    period: 100,
  });
}

function subscribePathsFor(options) {
  const paths = [];
  if (options.detection_mode === 'compound') {
    addSubscribePath(paths, options.voltage_path);
    addSubscribePath(paths, options.current_path);
    addSubscribePath(paths, options.power_path);
    addSubscribePath(paths, options.dc_system_path);
  } else {
    addSubscribePath(paths, options.observe_path);
  }
  if (options.use_chargingmode) {
    addSubscribePath(paths, options.chargingmodePath);
  }
  return paths;
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
    const subscription = {
      context: 'vessels.self',
      subscribe: subscribePathsFor(opts),
    };

    let publishedState = 'stopped';
    let pendingState = null;
    const samples = {
      voltage: null,
      current: null,
      power: null,
      dcSystemPower: null,
    };

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
            if (opts.use_chargingmode) {
              return;
            }
            if (opts.detection_mode === 'compound') {
              const key = compoundSampleKey(v.path, opts);
              if (!key) {
                return;
              }
              samples[key] = v.value;
              const currentlyStarted = publishedState === 'started';
              const started = nextCompoundStarted(samples, opts, currentlyStarted);
              consider(started ? 'started' : 'stopped');
              return;
            }
            if (v.path === opts.observe_path) {
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
      detection_mode: {
        type: 'string',
        enum: [...DETECTION_MODES],
        default: DEFAULTS.detection_mode,
        title: 'Detection mode',
        description: 'simple: one observe path with polarity, threshold, and '
          + 'hysteresis. compound: DC-system power OR battery voltage/current/'
          + 'power. OFF is NOT(hold), not a competing expression: while '
          + 'started, stay started until HOLD is false. ON is only used to '
          + 'enter started from stopped.',
      },
      observe_path: {
        type: 'string',
        default: DEFAULTS.observe_path,
        title: 'Observe path (simple mode)',
        description: 'Signal K path for current or power used to detect engine-on',
      },
      threshold: {
        type: 'number',
        default: DEFAULTS.threshold,
        title: 'Threshold (simple mode)',
        description: 'Crossed according to polarity to publish started',
      },
      polarity: {
        type: 'string',
        enum: [...POLARITIES],
        default: DEFAULTS.polarity,
        title: 'Polarity (simple mode)',
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
        title: 'Hysteresis (simple mode)',
        description: 'Band (same units as threshold) recrossed before leaving started',
      },
      holdoff_ms: {
        type: 'number',
        default: DEFAULTS.holdoff_ms,
        title: 'Hold-off (ms)',
        description: 'Milliseconds a new state must persist before it is published. '
          + 'Applies to both simple and compound modes.',
      },
      voltage_path: {
        type: 'string',
        default: DEFAULTS.voltage_path,
        title: 'Battery voltage path (compound mode)',
        description: 'Signal K path for battery voltage in volts',
      },
      current_path: {
        type: 'string',
        default: DEFAULTS.current_path,
        title: 'Battery current path (compound mode)',
        description: 'Signal K path for battery current in amperes '
          + '(positive = charging, Victron/VRM convention)',
      },
      power_path: {
        type: 'string',
        default: DEFAULTS.power_path,
        title: 'Battery power path (compound mode)',
        description: 'Signal K path for battery power in watts '
          + '(positive = charging). Not the VRM DC System value.',
      },
      dc_system_path: {
        type: 'string',
        default: DEFAULTS.dc_system_path,
        title: 'DC System power path (compound mode)',
        description: 'VRM "DC System" / Venus dbus /Dc/System/Power. Leave empty '
          + 'to disable this OR clause (voltage/current/power can still start '
          + 'the engine). Example from signalk-venus-plugin: '
          + 'electrical.{venusName}.dcPower (often electrical.venus.dcPower).',
      },
      dc_polarity: {
        type: 'string',
        enum: [...POLARITIES],
        default: DEFAULTS.dc_polarity,
        title: 'DC System polarity (compound mode)',
        description: 'How ON/HOLD compare DC System power to the thresholds. '
          + 'negative (default, VRM-style): power ≤ threshold. '
          + 'positive (Signal K electrical.venus.dcPower on Tequila Mockingbird): '
          + 'power ≥ threshold. absolute: |power| ≥ |threshold|.',
      },
      on_dc_max: {
        type: 'number',
        default: DEFAULTS.on_dc_max,
        title: 'ON: DC System power threshold (W)',
        description: 'Enter started when DC System power meets this threshold '
          + '(default −100). negative polarity ⇒ power ≤ threshold; '
          + 'positive ⇒ power ≥ threshold; absolute ⇒ |power| ≥ |threshold|. '
          + 'Used only from stopped.',
      },
      hold_dc_max: {
        type: 'number',
        default: DEFAULTS.hold_dc_max,
        title: 'HOLD: DC System power threshold (W)',
        description: 'While started, keep started when DC System power meets this '
          + 'threshold (default −50). Same polarity as ON. Leaving started is '
          + 'NOT(hold), not a separate OFF expression.',
      },
      on_voltage_min: {
        type: 'number',
        default: DEFAULTS.on_voltage_min,
        title: 'ON: battery voltage min (V)',
        description: 'Part of the ON voltage AND current AND power clause '
          + '(default 14.0). Used only from stopped.',
      },
      hold_voltage_min: {
        type: 'number',
        default: DEFAULTS.hold_voltage_min,
        title: 'HOLD: battery voltage min (V)',
        description: 'Part of HOLD voltage AND current AND power (default 13.7).',
      },
      on_current_min: {
        type: 'number',
        default: DEFAULTS.on_current_min,
        title: 'ON: battery current min (A)',
        description: 'Part of the ON voltage AND current AND power clause '
          + '(default 10). Used only from stopped.',
      },
      hold_current_min: {
        type: 'number',
        default: DEFAULTS.hold_current_min,
        title: 'HOLD: battery current min (A)',
        description: 'Part of HOLD voltage AND current AND power (default 5).',
      },
      on_power_min: {
        type: 'number',
        default: DEFAULTS.on_power_min,
        title: 'ON: battery power min (W)',
        description: 'Part of the ON voltage AND current AND power clause '
          + '(default 100). Used only from stopped.',
      },
      hold_power_min: {
        type: 'number',
        default: DEFAULTS.hold_power_min,
        title: 'HOLD: battery power min (W)',
        description: 'Part of HOLD voltage AND current AND power (default 50).',
      },
      use_chargingmode: {
        type: 'boolean',
        default: DEFAULTS.use_chargingmode,
        title: 'Use charging mode instead of electrical detection (Orion XS)',
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
module.exports.DETECTION_MODES = DETECTION_MODES;
module.exports.POLARITIES = POLARITIES;
module.exports.resolveOptions = resolveOptions;
module.exports.isEngineStarted = isEngineStarted;
module.exports.dcPowerMeets = dcPowerMeets;
module.exports.compoundOn = compoundOn;
module.exports.compoundHold = compoundHold;
module.exports.nextCompoundStarted = nextCompoundStarted;
