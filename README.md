# signalk-electrical-engine-on

Fork of [meri-imperiumi/signalk-alternator-engine-on](https://github.com/meri-imperiumi/signalk-alternator-engine-on) (MIT). This package is renamed so it can be installed next to `@meri-imperiumi/signalk-alternator-engine-on` without colliding.

Publishes `started` | `stopped` on a Signal K propulsion path from electrical data. Two detection modes:

- **simple** (default) — one observe path, threshold, polarity, and hysteresis
- **compound** — DC System power **OR** battery voltage/current/power, with a nested HOLD band so ON and OFF never fight

Downstream tools (for example Trip Report) can prefer `propulsion.*.state` instead of inferring engine-on from raw electrical data.

## Warning

House-bank sensing can **false-positive** on solar, shore power, DC-DC charging, or other large loads that are not the engine. Validate on the vessel before relying on this for trip reports or engine hours. An alternator SmartShunt (the upstream plugin’s model) is more specific when you have one.

## Detection modes

### simple (default)

Until engine-ON samples are locked in, defaults are deliberately conservative so an idle house bank does not look like a running engine.

Tequila Mockingbird’s observed OFF baseline on `electrical.batteries.277` is about **−1.4 A** (~−18 W). Defaults:

| Setting | Default | Why |
| --- | --- | --- |
| Detection mode | `simple` | Single-path threshold, unchanged from 2.0.0 |
| Observe path | `electrical.batteries.277.current` | House battery current (A), not alternator power |
| Polarity | `negative` | Charging/in from the engine is negative current on this shunt |
| Threshold | `8` (amperes) | Started only when value **< −8 A**. −1.4 A is clearly `stopped` |
| Output path | `propulsion.main.state` | Values: `started` \| `stopped` |
| Hysteresis | `1` | Must recross 7 A equivalent before leaving `started` |
| Hold-off | `1500` ms | Ignores brief spikes |

The plugin publishes `stopped` as soon as it starts, then updates from the observe path.

```json
{
  "detection_mode": "simple",
  "observe_path": "electrical.batteries.277.current",
  "polarity": "negative",
  "threshold": 8,
  "output_path": "propulsion.main.state",
  "hysteresis": 1,
  "holdoff_ms": 1500
}
```

### compound

A single current/power threshold is not enough when the bank is in absorption with solar: DC System no longer goes strongly negative, but voltage/current/power still show charging.

State machine (ON and HOLD never compete):

1. If currently `stopped` and **ON** is true → `started`
2. If currently `started` and **HOLD** is false → `stopped`
3. Else keep the previous state

**OFF is NOT(hold)**, not a second competing expression. ON is only used to *enter* `started`. Anything that satisfies ON also satisfies HOLD (strict thresholds nested inside loose ones).

**ON** (enter started):

`(DC System power meets on_dc_max per dc_polarity)`
**OR** `(batteryVoltage >= on_voltage_min` **AND** `batteryCurrent >= on_current_min` **AND** `batteryPower >= on_power_min)`

**HOLD** (stay started):

`(DC System power meets hold_dc_max per dc_polarity)`
**OR** `(batteryVoltage >= hold_voltage_min` **AND** `batteryCurrent >= hold_current_min` **AND** `batteryPower >= hold_power_min)`

`dc_polarity` (default `negative`, same three values as simple-mode `polarity`):

| Polarity | ON / HOLD comparison | Typical source |
| --- | --- | --- |
| `negative` | `dcSystemPower <= threshold` | Victron VRM Advanced “DC System” (negative while motoring) |
| `positive` | `dcSystemPower >= threshold` | Signal K `electrical.venus.dcPower` on Tequila Mockingbird (positive while motoring) |
| `absolute` | `\|dcSystemPower\| >= \|threshold\|` | Either sign; uses the absolute value of the configured threshold |

A clause with no finite sample yet is treated as false (does not crash). If neither ON-true nor a *clear* HOLD-false can be evaluated yet, the previous overall state is kept.

Validated defaults (Tequila Mockingbird, week of VRM data + two confirmed motor windows):

| Setting | Default | Notes |
| --- | --- | --- |
| Voltage path | `electrical.batteries.277.voltage` | Battery monitor instance 277 |
| Current path | `electrical.batteries.277.current` | Positive = charging (Victron/VRM) |
| Power path | `electrical.batteries.277.power` | Battery power, **not** VRM DC System |
| DC System path | *(empty)* | Optional. Disable that OR clause until set |
| DC polarity | `negative` | Unset configs keep 2.1.0 VRM-style `≤`. Use `positive` when Signal K DC power is ≥ while motoring |
| ON DC threshold | `−100` W | Compared per `dc_polarity` (default: `dcSystemPower <= -100`) |
| HOLD DC threshold | `−50` W | Compared per `dc_polarity` (default: `dcSystemPower <= -50`) |
| ON V / I / P | `14.0` V, `10` A, `100` W | All three required |
| HOLD V / I / P | `13.7` V, `5` A, `50` W | All three required |
| Hold-off | `1500` ms | Same debounce as simple mode |

**DC System path:** Venus dbus `/Dc/System/Power` (VRM “DC System” / System overview). The Signal K [venus plugin](https://github.com/sbender9/signalk-venus-plugin) publishes it as `electrical.{venusName}.dcPower` (often `electrical.venus.dcPower`). Confirm the **sign** in Data Browser: VRM Advanced is typically negative while motoring (`dc_polarity: negative`); Tequila Mockingbird’s Signal K path is **positive** while motoring (`dc_polarity: positive`). Leave the path empty if it is missing — the voltage/current/power OR clause still works.

Battery power (`electrical.batteries.277.power`) is **not** DC System. `on_dc_max` / `hold_dc_max` keep those field names for compatibility; they are magnitude thresholds. Polarity selects `≤` vs `≥` vs `|DC|`.

#### Tequila Mockingbird example (compound)

Signal K `electrical.venus.dcPower` is positive while motoring, so ON is DC ≥ 100 W and HOLD is DC ≥ 50 W:

```json
{
  "detection_mode": "compound",
  "output_path": "propulsion.main.state",
  "holdoff_ms": 1500,
  "voltage_path": "electrical.batteries.277.voltage",
  "current_path": "electrical.batteries.277.current",
  "power_path": "electrical.batteries.277.power",
  "dc_system_path": "electrical.venus.dcPower",
  "dc_polarity": "positive",
  "on_dc_max": 100,
  "hold_dc_max": 50,
  "on_voltage_min": 14.0,
  "hold_voltage_min": 13.7,
  "on_current_min": 10,
  "hold_current_min": 5,
  "on_power_min": 100,
  "hold_power_min": 50
}
```

A VRM-style install (negative while motoring) can omit `dc_polarity` or set it to `negative` and keep `on_dc_max: -100` / `hold_dc_max: -50`. Set `dc_system_path` to the path your Venus/Signal K install actually publishes. If unsure, leave it `""` and rely on the V/I/P clause.

## Settings (Admin UI)

Plugin Config settings apply on save (plugin stop/start). You do not need to reinstall.

- **Detection mode** — `simple` or `compound`. Compound OFF is NOT(hold); ON is only the enter-started rule.
- **Observe path / Threshold / Polarity / Hysteresis** — simple mode
  - `positive`: value > threshold ⇒ `started` (alternator power in watts)
  - `negative`: value < −threshold ⇒ `started` (house-bank current into the battery)
  - `absolute`: \|value\| > threshold ⇒ `started`
- **Output path** — default `propulsion.main.state`
- **Hold-off** — optional chatter control (both modes)
- **Compound paths and ON/HOLD thresholds** — voltage, current, power, DC System; `on_*` enter started, `hold_*` stay started
- **DC System polarity** — compound mode only. `negative` (default): DC ≤ threshold; `positive`: DC ≥ threshold; `absolute`: \|DC\| ≥ \|threshold\|
- **Use charging mode** — optional Victron Orion XS `chargingMode` override (unchanged from upstream)

## Install (Signal K on a Raspberry Pi)

From npm (after this version is published):

```bash
npm install --prefix ~/.signalk signalk-electrical-engine-on
sudo systemctl restart signalk.service
```

Or from git into the Signal K server prefix (`~/.signalk` on a typical Pi image):

```bash
npm install --prefix ~/.signalk git+https://github.com/dgplace/signalk-electrical-engine-on.git
sudo systemctl restart signalk.service
```

Equivalent, from the Signal K data directory:

```bash
cd ~/.signalk
npm install signalk-electrical-engine-on
sudo systemctl restart signalk.service
```

In Admin UI: **Appstore** → install `signalk-electrical-engine-on` (or from the git URL if your server build supports git installs), then **Server → Plugin Config → Electrical Engine Status Detector**. Enable the plugin and choose simple or compound settings.

npm package name: `signalk-electrical-engine-on` (plugin id `signalk-electrical-engine-on`). Display name: Electrical Engine Status Detector.

## License

MIT. Copyright (c) 2022 meri-imperiumi; copyright (c) 2026 David Place. See [LICENSE](LICENSE).

## Changes

See [Changelog](CHANGELOG.md).
