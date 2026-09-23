# Changelog

## [2.0.0] - 2026-09-23

Fork of [signalk-alternator-engine-on](https://github.com/meri-imperiumi/signalk-alternator-engine-on). Package renamed to `signalk-electrical-engine-on`.

### Changed
- Detect engine running from a configurable observe path, threshold, and polarity instead of hardcoded alternator power > 5 W
- OFF-biased defaults for house-bank current (`electrical.batteries.277.current`, polarity `negative`, threshold 8 A)
- Publish `stopped` on start until a qualifying engine-ON sample is held
- Optional hysteresis and hold-off to reduce chatter

### Added
- Admin UI settings: observe path, threshold, polarity (`positive` / `negative` / `absolute`), output path

## [1.2.1] - 2026-06-16
### Changed
- App icon for SK app store

## [1.2.0] - 2025-02-16
### Added
- Added support for uppercase charging modes reported by some DC-DC chargers

## [1.1.1] - 2024-05-31
### Fixed
- Prevent false state changes when receiving a `null` value

## [1.1.0] - 2024-04-08
### Added
- Added support for utilizing `chargingMode` as populated by the Victron Orion XS DC-DC charger

## [1.0.0] - 2022-02-04
### Added
- Initial release
