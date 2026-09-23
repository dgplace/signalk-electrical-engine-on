# signalk-electrical-engine-on

Fork of [meri-imperiumi/signalk-alternator-engine-on](https://github.com/meri-imperiumi/signalk-alternator-engine-on) (MIT). This package is renamed so it can be installed next to `@meri-imperiumi/signalk-alternator-engine-on` without colliding.

Publishes `started` | `stopped` on a Signal K propulsion path from a **configurable** electrical observe path, threshold, and polarity. Downstream tools (for example Trip Report) can prefer `propulsion.*.state` instead of inferring engine-on from raw electrical data.

## Warning

House-bank sensing can **false-positive** on solar, shore power, DC-DC charging, or other large loads that are not the engine. Validate on the vessel before relying on this for trip reports or engine hours. An alternator SmartShunt (the upstream plugin’s model) is more specific when you have one.

## Defaults (OFF-biased)

Until engine-ON samples are locked in, defaults are deliberately conservative so an idle house bank does not look like a running engine.

Tequila Mockingbird’s observed OFF baseline on `electrical.batteries.277` is about **−1.4 A** (~−18 W). Defaults:

| Setting | Default | Why |
| --- | --- | --- |
| Observe path | `electrical.batteries.277.current` | House battery current (A), not alternator power |
| Polarity | `negative` | Charging/in from the engine is negative current on this shunt |
| Threshold | `8` (amperes) | Started only when value **< −8 A**. −1.4 A is clearly `stopped` |
| Output path | `propulsion.main.state` | Values: `started` \| `stopped` |
| Hysteresis | `1` | Must recross 7 A equivalent before leaving `started` |
| Hold-off | `1500` ms | Ignores brief spikes |

The plugin publishes `stopped` as soon as it starts, then updates from the observe path.

### Tequila Mockingbird example config

ON-sample defaults are **not locked yet** (replace `threshold` after measuring engine-ON current):

```json
{
  "observe_path": "electrical.batteries.277.current",
  "polarity": "negative",
  "threshold": 8,
  "output_path": "propulsion.main.state",
  "hysteresis": 1,
  "holdoff_ms": 1500
}
```

## Settings (Admin UI)

Plugin Config settings apply on save (plugin stop/start). You do not need to reinstall.

- **Observe path** — Signal K path for current or power
- **Threshold** — number, same units as the observe path
- **Polarity**
  - `positive`: value > threshold ⇒ `started` (alternator power in watts)
  - `negative`: value < −threshold ⇒ `started` (house-bank current into the battery)
  - `absolute`: \|value\| > threshold ⇒ `started`
- **Output path** — default `propulsion.main.state`
- **Hysteresis** / **Hold-off** — optional chatter control
- **Use charging mode** — optional Victron Orion XS `chargingMode` override (unchanged from upstream)

## Install (Signal K on a Raspberry Pi)

Install from git into the Signal K server prefix (`~/.signalk` on a typical Pi image). Prefer this over copying files by hand:

```bash
npm install --prefix ~/.signalk git+https://github.com/dgplace/signalk-electrical-engine-on.git
sudo systemctl restart signalk.service
```

Equivalent, from the Signal K data directory:

```bash
cd ~/.signalk
npm install git+https://github.com/dgplace/signalk-electrical-engine-on.git
sudo systemctl restart signalk.service
```

In Admin UI: **Appstore** → install from that git URL if your server build supports git installs, then **Server → Plugin Config → Electrical Engine Status Detector**. Enable the plugin and set observe path / threshold / polarity.

npm package name: `signalk-electrical-engine-on` (plugin id `signalk-electrical-engine-on`). Display name: Electrical Engine Status Detector.

## License

MIT. Copyright (c) 2022 meri-imperiumi; copyright (c) 2026 David Place. See [LICENSE](LICENSE).

## Changes

See [Changelog](CHANGELOG.md).
