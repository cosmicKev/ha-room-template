# Room Template

One room as one card: how warm it is, what to set it to, the lights, and what the
sockets are drawing and costing.

```
Living Room                              21.4°   48%
─────────────────────────────────────────────────────
Target · Radiator · now 20.1°   [ − ]  21.5°  [ + ]
[ Couch lights 45% ] [ Dinning table  Off ]
[ Entretainment  84 W · €0.02/h ] [ Fridge  61 W · €0.02/h ]
                                       Now €0.28/kWh
```

```yaml
type: custom:ha-room-template
area: living_room
```

Everything else is discovered from the area. Rows with nothing in them are not
drawn, so a room with no lights shows no light row rather than an empty one.

## What it does

**The header is the room.** Its name, and the temperature and humidity in it. If
the area has a temperature or humidity entity assigned, that is what is shown;
otherwise the first sensor of that class in the room. One reading per class, so
a room with a radiator and a presence sensor does not print its temperature
twice.

**One target temperature, whichever device owns it.** Where a room has an air
conditioner it wins — cheaper to run than a radiator — and the card sends the
target there instead. Two shapes are supported: a `climate` entity of its own,
or the helper-and-script route an IR-driven unit needs. With no aircon
configured, with its mode `off`, or with its entities missing, the radiator gets
it. The row says which device it is driving, so a room with both is never a
guess.

**Sockets show what they are doing, and what that costs.** A plug with a usable
switch is a button: tap to toggle, with its live draw on it. A plug without one
— a fridge, a boiling-water tap, anything deliberately not switchable from a
dashboard — is a greyed reading rather than a control that looks broken. Both
carry the price *per hour at the current tariff*, and the card footer carries the
tariff itself.

Price is a rate, not a total: watts at the price of the block you are in. A
dynamic tariff that steps every quarter hour is read live, so what the card shows
is what the socket is costing right now.

## Options

| Option | Default | What |
|---|---|---|
| `area` | — | **Required.** The area id, e.g. `living_room` |
| `name` | the area's name | Header title |
| `climate.radiator` | first `climate` in the area | Fallback thermostat |
| `climate.aircon` | — | A `climate` entity that takes priority when not off |
| `climate.aircon_ir` | — | `{temperature, mode, apply}` for an IR-driven unit |
| `tariff` | see below | €/kWh sensor for the price |
| `step` | `0.5` | Degrees per press |
| `show_climate` / `show_lights` / `show_sockets` / `show_price` | `true` | Rows |

Tariff resolution, finest price block first: the configured `tariff`, then the
Currentt import tariff, then Zonneplan's quarter-hourly, hourly and headline
sensors. Each is tested for a numeric value rather than for a sentinel, because
a dynamic price can legitimately be **below zero** and those are exactly the
hours worth seeing.

## Install

HACS → ⋮ → Custom repositories → `https://github.com/cosmicKev/ha-room-template`
as **Dashboard** → install *Room Template*.

Or copy `dist/ha-room-template.js` into `config/www/community/ha-room-template/`
and add it as a `module` resource.

## Written without a build step

A plain custom element: no Lit, no bundler, nothing to compile. Every colour
comes from Home Assistant's theme variables, so the card follows whatever theme
is active.

## Licence

MIT
