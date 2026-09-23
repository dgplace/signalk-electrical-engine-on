const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');

const { DEFAULTS, isEngineStarted, resolveOptions } = pluginFactory;

function publishedState(message) {
  return message.delta.updates[0].values[0].value;
}

function publishedPath(message) {
  return message.delta.updates[0].values[0].path;
}

function createApp() {
  let onDelta = () => {};
  let lastSubscription;
  const messages = [];
  const app = {
    selfId: 'urn:mrn:signalk:uuid:test',
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    handleMessage: (id, delta) => {
      messages.push({ id, delta });
    },
    subscriptionmanager: {
      subscribe: (subscription, unsubscribes, _onError, cb) => {
        lastSubscription = subscription;
        onDelta = cb;
        unsubscribes.push(() => {
          onDelta = () => {};
        });
      },
    },
  };
  return {
    app,
    messages,
    getSubscription: () => lastSubscription,
    send(path, value) {
      onDelta({
        updates: [{ values: [{ path, value }] }],
      });
    },
    sendEmpty() {
      onDelta({});
    },
  };
}

describe('plugin interface', () => {
  const harness = createApp();
  const plugin = pluginFactory(harness.app);

  it('has required interface and renamed id', () => {
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.equal(plugin.id, 'signalk-electrical-engine-on');
    assert.equal(plugin.name, 'Electrical engine status detector');
  });

  it('exposes schema for observe path, threshold, polarity, and output path', () => {
    const { properties } = plugin.schema;
    assert.equal(properties.observe_path.default, 'electrical.batteries.277.current');
    assert.equal(properties.threshold.default, 8);
    assert.deepEqual(properties.polarity.enum, ['positive', 'negative', 'absolute']);
    assert.equal(properties.polarity.default, 'negative');
    assert.equal(properties.output_path.default, 'propulsion.main.state');
  });

  it('starts and stops without error', () => {
    plugin.start({}, () => {});
    plugin.stop();
  });
});

describe('isEngineStarted polarity', () => {
  it('positive: value > threshold ⇒ started', () => {
    const opts = resolveOptions({
      polarity: 'positive',
      threshold: 5,
      hysteresis: 0,
    });
    assert.equal(isEngineStarted(5.1, opts, false), true);
    assert.equal(isEngineStarted(5, opts, false), false);
    assert.equal(isEngineStarted(4, opts, false), false);
  });

  it('negative: value < −threshold ⇒ started', () => {
    const opts = resolveOptions({
      polarity: 'negative',
      threshold: 8,
      hysteresis: 0,
    });
    assert.equal(isEngineStarted(-8.1, opts, false), true);
    assert.equal(isEngineStarted(-8, opts, false), false);
    assert.equal(isEngineStarted(8.1, opts, false), false);
  });

  it('absolute: |value| > threshold ⇒ started', () => {
    const opts = resolveOptions({
      polarity: 'absolute',
      threshold: 5,
      hysteresis: 0,
    });
    assert.equal(isEngineStarted(5.1, opts, false), true);
    assert.equal(isEngineStarted(-5.1, opts, false), true);
    assert.equal(isEngineStarted(1, opts, false), false);
    assert.equal(isEngineStarted(-1, opts, false), false);
  });

  it('OFF baseline −1.4 A is stopped with default negative / 8 A threshold', () => {
    const opts = resolveOptions({});
    assert.equal(opts.observe_path, 'electrical.batteries.277.current');
    assert.equal(opts.polarity, 'negative');
    assert.equal(opts.threshold, 8);
    assert.equal(isEngineStarted(-1.4, opts, false), false);
    assert.equal(isEngineStarted(-1.4, opts, true), false);
    assert.equal(isEngineStarted(-18 / 12.8, opts, false), false);
  });

  it('does not start on invalid samples', () => {
    const opts = resolveOptions({});
    assert.equal(isEngineStarted(null, opts, false), false);
    assert.equal(isEngineStarted(undefined, opts, false), false);
    assert.equal(isEngineStarted('not-a-number', opts, false), false);
  });

  it('hysteresis keeps started until the stop band is recrossed', () => {
    const opts = resolveOptions({
      polarity: 'negative',
      threshold: 8,
      hysteresis: 1,
    });
    assert.equal(isEngineStarted(-8.5, opts, false), true);
    assert.equal(isEngineStarted(-7.5, opts, true), true);
    assert.equal(isEngineStarted(-6.9, opts, true), false);
  });
});

describe('subscribe → publish', () => {
  it('publishes stopped on start (OFF-biased) to the output path', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({ holdoff_ms: 0 });
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0].id, 'signalk-electrical-engine-on');
    assert.equal(publishedState(harness.messages[0]), 'stopped');
    assert.equal(publishedPath(harness.messages[0]), 'propulsion.main.state');
    const sub = harness.getSubscription();
    assert.equal(sub.context, 'vessels.self');
    assert.equal(sub.subscribe[0].path, DEFAULTS.observe_path);
    plugin.stop();
  });

  it('does not start the engine on TM OFF baseline current', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({ holdoff_ms: 0 });
    harness.send('electrical.batteries.277.current', -1.4);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('publishes started for negative polarity below −threshold', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({ holdoff_ms: 0 });
    harness.send('electrical.batteries.277.current', -20);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    plugin.stop();
  });

  it('publishes started for positive polarity above threshold', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({
      observe_path: 'electrical.chargers.alternator.power',
      polarity: 'positive',
      threshold: 5,
      hysteresis: 0,
      holdoff_ms: 0,
    });
    harness.send('electrical.chargers.alternator.power', 6);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    harness.send('electrical.chargers.alternator.power', 4);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('publishes started for absolute polarity on either sign', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({
      polarity: 'absolute',
      threshold: 5,
      hysteresis: 0,
      holdoff_ms: 0,
      output_path: 'propulsion.port.state',
    });
    assert.equal(publishedPath(harness.messages[0]), 'propulsion.port.state');
    harness.send('electrical.batteries.277.current', -6);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    harness.send('electrical.batteries.277.current', 6);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    harness.send('electrical.batteries.277.current', 1);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('ignores other paths and empty deltas', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({ holdoff_ms: 0 });
    harness.sendEmpty();
    harness.send('navigation.speedThroughWater', 3);
    assert.equal(harness.messages.length, 1);
    assert.equal(publishedState(harness.messages[0]), 'stopped');
    plugin.stop();
  });

  it('hold-off delays started until the sample persists', () => {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({ holdoff_ms: 50, hysteresis: 0 });
    harness.send('electrical.batteries.277.current', -20);
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          assert.equal(
            publishedState(harness.messages[harness.messages.length - 1]),
            'started',
          );
          plugin.stop();
          resolve();
        } catch (err) {
          plugin.stop();
          reject(err);
        }
      }, 80);
    });
  });
});
