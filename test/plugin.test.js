const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');

const {
  DEFAULTS,
  compoundHold,
  compoundOn,
  isEngineStarted,
  nextCompoundStarted,
  resolveOptions,
} = pluginFactory;

const COMPOUND_DC_PATH = 'electrical.venus.dcPower';
const COMPOUND_PATHS = {
  voltage: 'electrical.batteries.277.voltage',
  current: 'electrical.batteries.277.current',
  power: 'electrical.batteries.277.power',
  dc: COMPOUND_DC_PATH,
};

function compoundOptions(overrides = {}) {
  return resolveOptions({
    detection_mode: 'compound',
    dc_system_path: COMPOUND_DC_PATH,
    holdoff_ms: 0,
    ...overrides,
  });
}

function sendCompound(harness, samples) {
  if (Object.prototype.hasOwnProperty.call(samples, 'voltage')) {
    harness.send(COMPOUND_PATHS.voltage, samples.voltage);
  }
  if (Object.prototype.hasOwnProperty.call(samples, 'current')) {
    harness.send(COMPOUND_PATHS.current, samples.current);
  }
  if (Object.prototype.hasOwnProperty.call(samples, 'power')) {
    harness.send(COMPOUND_PATHS.power, samples.power);
  }
  if (Object.prototype.hasOwnProperty.call(samples, 'dc')) {
    harness.send(COMPOUND_PATHS.dc, samples.dc);
  }
}

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
    assert.equal(properties.detection_mode.default, 'simple');
    assert.deepEqual(properties.detection_mode.enum, ['simple', 'compound']);
    assert.equal(properties.observe_path.default, 'electrical.batteries.277.current');
    assert.equal(properties.threshold.default, 8);
    assert.deepEqual(properties.polarity.enum, ['positive', 'negative', 'absolute']);
    assert.equal(properties.polarity.default, 'negative');
    assert.equal(properties.output_path.default, 'propulsion.main.state');
    assert.equal(properties.voltage_path.default, 'electrical.batteries.277.voltage');
    assert.equal(properties.current_path.default, 'electrical.batteries.277.current');
    assert.equal(properties.power_path.default, 'electrical.batteries.277.power');
    assert.equal(properties.dc_system_path.default, '');
    assert.deepEqual(properties.dc_polarity.enum, ['positive', 'negative', 'absolute']);
    assert.equal(properties.dc_polarity.default, 'negative');
    assert.equal(properties.on_dc_max.default, -100);
    assert.equal(properties.hold_dc_max.default, -50);
    assert.match(properties.on_dc_max.title, /threshold/);
    assert.match(properties.dc_polarity.description, /negative \(default/);
    assert.equal(properties.on_voltage_min.default, 14);
    assert.equal(properties.hold_voltage_min.default, 13.7);
    assert.equal(properties.on_current_min.default, 10);
    assert.equal(properties.hold_current_min.default, 5);
    assert.equal(properties.on_power_min.default, 100);
    assert.equal(properties.hold_power_min.default, 50);
    assert.match(properties.detection_mode.description, /NOT\(hold\)/);
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

describe('compound detection', () => {
  const dcOn = {
    voltage: 12.8,
    current: 0,
    power: 0,
    dcSystemPower: -150,
  };
  const vipOn = {
    voltage: 14.2,
    current: 15,
    power: 210,
    dcSystemPower: 40,
  };
  const betweenOnAndHold = {
    voltage: 13.8,
    current: 6,
    power: 80,
    dcSystemPower: -75,
  };
  const holdFalse = {
    voltage: 13.4,
    current: 2,
    power: 20,
    dcSystemPower: 10,
  };

  it('defaults to simple mode and nested ON/HOLD thresholds', () => {
    const simple = resolveOptions({});
    assert.equal(simple.detection_mode, 'simple');
    const opts = compoundOptions();
    assert.equal(opts.detection_mode, 'compound');
    assert.equal(opts.dc_polarity, 'negative');
    assert.equal(opts.on_dc_max, -100);
    assert.equal(opts.hold_dc_max, -50);
    assert.equal(opts.on_voltage_min, 14);
    assert.equal(opts.hold_voltage_min, 13.7);
    assert.equal(opts.on_current_min, 10);
    assert.equal(opts.hold_current_min, 5);
    assert.equal(opts.on_power_min, 100);
    assert.equal(opts.hold_power_min, 50);
  });

  it('ON via DC alone when battery is not in the VIP band', () => {
    const opts = compoundOptions();
    assert.equal(compoundOn(dcOn, opts), true);
    assert.equal(compoundOn({
      voltage: 12.8,
      current: 0,
      power: 0,
      dcSystemPower: 40,
    }, opts), false);
    assert.equal(nextCompoundStarted(dcOn, opts, false), true);
  });

  it('ON via voltage/current/power when DC is not negative', () => {
    const opts = compoundOptions();
    assert.equal(compoundOn(vipOn, opts), true);
    assert.equal(nextCompoundStarted(vipOn, opts, false), true);
  });

  it('ON implies HOLD so the two expressions never conflict', () => {
    const opts = compoundOptions();
    [dcOn, vipOn].forEach((samples) => {
      assert.equal(compoundOn(samples, opts), true);
      assert.equal(compoundHold(samples, opts), true);
    });
    assert.equal(compoundOn(betweenOnAndHold, opts), false);
    assert.equal(compoundHold(betweenOnAndHold, opts), true);
  });

  it('hysteresis band keeps started when between ON and HOLD', () => {
    const opts = compoundOptions();
    assert.equal(nextCompoundStarted(betweenOnAndHold, opts, false), false);
    assert.equal(nextCompoundStarted(betweenOnAndHold, opts, true), true);
  });

  it('drops to stopped when HOLD is false', () => {
    const opts = compoundOptions();
    assert.equal(compoundHold(holdFalse, opts), false);
    assert.equal(nextCompoundStarted(holdFalse, opts, true), false);
    assert.equal(nextCompoundStarted(holdFalse, opts, false), false);
  });

  it('missing samples keep previous state (do not crash)', () => {
    const opts = compoundOptions();
    const empty = {
      voltage: null,
      current: undefined,
      power: 'not-a-number',
    };
    assert.equal(compoundOn(empty, opts), null);
    assert.equal(compoundHold(empty, opts), null);
    assert.equal(nextCompoundStarted(empty, opts, false), false);
    assert.equal(nextCompoundStarted(empty, opts, true), true);
    assert.equal(nextCompoundStarted({ dcSystemPower: null }, opts, true), true);
  });

  it('VIP clause still works when dc_system_path is unset', () => {
    const opts = compoundOptions({ dc_system_path: '' });
    assert.equal(opts.dc_system_path, '');
    assert.equal(nextCompoundStarted(vipOn, opts, false), true);
    assert.equal(nextCompoundStarted(dcOn, opts, false), false);
  });

  it('falls back to negative DC polarity when the value is unknown', () => {
    const opts = compoundOptions({ dc_polarity: 'sideways' });
    assert.equal(opts.dc_polarity, 'negative');
    assert.equal(compoundOn(dcOn, opts), true);
  });
});

describe('compound DC polarity', () => {
  const idleBattery = {
    voltage: 12.8,
    current: 0,
    power: 0,
  };
  const vipOn = {
    voltage: 14.2,
    current: 15,
    power: 210,
  };

  function withDc(dcSystemPower) {
    return { ...idleBattery, dcSystemPower };
  }

  it('negative (legacy): ON when DC ≤ on_dc_max, HOLD when DC ≤ hold_dc_max', () => {
    const opts = compoundOptions();
    assert.equal(compoundOn(withDc(-150), opts), true);
    assert.equal(compoundHold(withDc(-150), opts), true);
    assert.equal(compoundOn(withDc(-100), opts), true);
    assert.equal(compoundOn(withDc(-99), opts), false);
    assert.equal(compoundHold(withDc(-50), opts), true);
    assert.equal(compoundHold(withDc(-49), opts), false);
    assert.equal(compoundOn(withDc(150), opts), false);
    assert.equal(compoundHold(withDc(150), opts), false);
    assert.equal(nextCompoundStarted(withDc(-75), opts, false), false);
    assert.equal(nextCompoundStarted(withDc(-75), opts, true), true);
  });

  it('positive: ON when DC ≥ threshold, HOLD when DC ≥ threshold', () => {
    const opts = compoundOptions({
      dc_polarity: 'positive',
      on_dc_max: 100,
      hold_dc_max: 50,
    });
    assert.equal(compoundOn(withDc(150), opts), true);
    assert.equal(compoundHold(withDc(150), opts), true);
    assert.equal(compoundOn(withDc(100), opts), true);
    assert.equal(compoundOn(withDc(99), opts), false);
    assert.equal(compoundHold(withDc(50), opts), true);
    assert.equal(compoundHold(withDc(49), opts), false);
    assert.equal(compoundOn(withDc(-150), opts), false);
    assert.equal(compoundHold(withDc(-150), opts), false);
    assert.equal(nextCompoundStarted(withDc(75), opts, false), false);
    assert.equal(nextCompoundStarted(withDc(75), opts, true), true);
  });

  it('absolute: ON/HOLD when |DC| ≥ |threshold| for both signs', () => {
    const opts = compoundOptions({
      dc_polarity: 'absolute',
      on_dc_max: 100,
      hold_dc_max: 50,
    });
    assert.equal(compoundOn(withDc(150), opts), true);
    assert.equal(compoundOn(withDc(-150), opts), true);
    assert.equal(compoundHold(withDc(150), opts), true);
    assert.equal(compoundHold(withDc(-150), opts), true);
    assert.equal(compoundOn(withDc(100), opts), true);
    assert.equal(compoundOn(withDc(-100), opts), true);
    assert.equal(compoundOn(withDc(99), opts), false);
    assert.equal(compoundOn(withDc(-99), opts), false);
    assert.equal(compoundHold(withDc(50), opts), true);
    assert.equal(compoundHold(withDc(-50), opts), true);
    assert.equal(compoundHold(withDc(49), opts), false);
    assert.equal(compoundHold(withDc(-49), opts), false);
    assert.equal(nextCompoundStarted(withDc(75), opts, false), false);
    assert.equal(nextCompoundStarted(withDc(-75), opts, true), true);
  });

  it('absolute uses |configured threshold| so default −100/−50 still match magnitude', () => {
    const opts = compoundOptions({ dc_polarity: 'absolute' });
    assert.equal(compoundOn(withDc(150), opts), true);
    assert.equal(compoundOn(withDc(-150), opts), true);
    assert.equal(compoundOn(withDc(99), opts), false);
    assert.equal(compoundHold(withDc(50), opts), true);
    assert.equal(compoundHold(withDc(-49), opts), false);
  });

  it('battery V/I/P OR still starts when DC polarity is positive and DC is below threshold', () => {
    const opts = compoundOptions({
      dc_polarity: 'positive',
      on_dc_max: 100,
      hold_dc_max: 50,
    });
    const samples = { ...vipOn, dcSystemPower: 40 };
    assert.equal(compoundOn(samples, opts), true);
    assert.equal(compoundHold(samples, opts), true);
    assert.equal(nextCompoundStarted(samples, opts, false), true);
  });

  it('empty dc_system_path still disables the DC clause for every polarity', () => {
    ['negative', 'positive', 'absolute'].forEach((dcPolarity) => {
      const opts = compoundOptions({
        dc_system_path: '',
        dc_polarity: dcPolarity,
        on_dc_max: 100,
        hold_dc_max: 50,
      });
      assert.equal(opts.dc_system_path, '');
      assert.equal(nextCompoundStarted(withDc(150), opts, false), false);
      assert.equal(nextCompoundStarted(withDc(-150), opts, false), false);
      assert.equal(nextCompoundStarted({ ...vipOn, dcSystemPower: 150 }, opts, false), true);
    });
  });
});

describe('compound subscribe → publish', () => {
  function startCompound(overrides = {}) {
    const harness = createApp();
    const plugin = pluginFactory(harness.app);
    plugin.start({
      detection_mode: 'compound',
      dc_system_path: COMPOUND_DC_PATH,
      holdoff_ms: 0,
      ...overrides,
    });
    return { harness, plugin };
  }

  it('subscribes to battery V/I/P and optional DC System path', () => {
    const { harness, plugin } = startCompound();
    const paths = harness.getSubscription().subscribe.map((entry) => entry.path);
    assert.deepEqual(paths, [
      COMPOUND_PATHS.voltage,
      COMPOUND_PATHS.current,
      COMPOUND_PATHS.power,
      COMPOUND_DC_PATH,
    ]);
    plugin.stop();
  });

  it('does not subscribe to DC System when the path is empty', () => {
    const { harness, plugin } = startCompound({ dc_system_path: '' });
    const paths = harness.getSubscription().subscribe.map((entry) => entry.path);
    assert.deepEqual(paths, [
      COMPOUND_PATHS.voltage,
      COMPOUND_PATHS.current,
      COMPOUND_PATHS.power,
    ]);
    plugin.stop();
  });

  it('publishes started from DC System power alone', () => {
    const { harness, plugin } = startCompound();
    sendCompound(harness, {
      voltage: 12.8,
      current: 0,
      power: 0,
      dc: -150,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    plugin.stop();
  });

  it('publishes started from positive DC polarity (Tequila Mockingbird)', () => {
    const { harness, plugin } = startCompound({
      dc_polarity: 'positive',
      on_dc_max: 100,
      hold_dc_max: 50,
    });
    sendCompound(harness, {
      voltage: 12.8,
      current: 0,
      power: 0,
      dc: 150,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    sendCompound(harness, { dc: 75 });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    sendCompound(harness, { dc: 40 });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('does not start on negative DC watts when polarity is positive', () => {
    const { harness, plugin } = startCompound({
      dc_polarity: 'positive',
      on_dc_max: 100,
      hold_dc_max: 50,
    });
    sendCompound(harness, {
      voltage: 12.8,
      current: 0,
      power: 0,
      dc: -150,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('publishes started from absolute DC polarity on either sign', () => {
    const { harness, plugin } = startCompound({
      dc_polarity: 'absolute',
      on_dc_max: 100,
      hold_dc_max: 50,
    });
    sendCompound(harness, {
      voltage: 12.8,
      current: 0,
      power: 0,
      dc: -150,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    sendCompound(harness, { dc: 40 });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    sendCompound(harness, { dc: 150 });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    plugin.stop();
  });

  it('publishes started from V/I/P while DC System is not negative', () => {
    const { harness, plugin } = startCompound();
    sendCompound(harness, {
      voltage: 14.2,
      current: 15,
      power: 210,
      dc: 40,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    plugin.stop();
  });

  it('keeps started in the band between ON and HOLD', () => {
    const { harness, plugin } = startCompound();
    sendCompound(harness, { dc: -150 });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    sendCompound(harness, {
      voltage: 13.8,
      current: 6,
      power: 80,
      dc: -75,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    plugin.stop();
  });

  it('publishes stopped when HOLD becomes false', () => {
    const { harness, plugin } = startCompound();
    sendCompound(harness, { dc: -150 });
    sendCompound(harness, {
      voltage: 13.4,
      current: 2,
      power: 20,
      dc: 10,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('does not start from HOLD-true / ON-false (OFF is NOT hold)', () => {
    const { harness, plugin } = startCompound();
    sendCompound(harness, {
      voltage: 13.8,
      current: 6,
      power: 80,
      dc: -75,
    });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'stopped');
    plugin.stop();
  });

  it('ignores invalid samples and holds previous state', () => {
    const { harness, plugin } = startCompound();
    sendCompound(harness, { dc: -150 });
    const afterStart = publishedState(harness.messages[harness.messages.length - 1]);
    assert.equal(afterStart, 'started');
    sendCompound(harness, { dc: null });
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    harness.send(COMPOUND_PATHS.voltage, 'nope');
    assert.equal(publishedState(harness.messages[harness.messages.length - 1]), 'started');
    plugin.stop();
  });

  it('hold-off delays compound started until the condition persists', () => {
    const { harness, plugin } = startCompound({ holdoff_ms: 50 });
    sendCompound(harness, { dc: -150 });
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
