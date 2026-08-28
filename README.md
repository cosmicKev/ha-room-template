# Room Template

One room as one card: how warm it is, what to set it to, the lights, and what the
sockets are drawing and costing.

```
Living Room                              21.4°   48%
─────────────────────────────────────────────────────
Target · Radiator · now 20.1°                   21.5°
 ────────────●───────────────────────────────────────
5°                                               30°
[ Couch lights 45% ] [ Dinning table  Off ]
[ Entretainment  84 W · €0.31 today ] [ Fridge  61 W · €0.22 today ]
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

**One target temperature, on a slider, whichever device owns it.** The slider
spans 15–25 °C rather than the device's full range: a radiator is never set to 5
or 30, and a slider that offers them spends most of its travel on temperatures
nobody picks. The reading follows the handle as you drag, and the service call
happens once, when you let go. A thermostat that is off says **Off** rather than
inventing a setpoint, with the handle at the bottom of the band — drag it up and
the card turns the thermostat on before setting the temperature, because on most
integrations a setpoint sent to an off thermostat lands on a valve that stays
shut. Where a room has an air
conditioner it wins — cheaper to run than a radiator — and the card sends the
target there instead. Two shapes are supported: a `climate` entity of its own,
or the helper-and-script route an IR-driven unit needs. With no aircon
configured, with its mode `off`, or with its entities missing, the radiator gets
it. The row says which device it is driving, so a room with both is never a
guess.

**Sockets show what they are drawing now, and what they have cost today.** Two
different questions: a fridge at 60 W tells you nothing about the month. A plug
with a usable switch is a button — tap to toggle, live draw and today's spend on
it. A plug without one (a fridge, a boiling-water tap, anything deliberately not
switchable from a dashboard) is a greyed reading rather than a control that looks
broken.

Today's spend comes from a `sensor.<device>_cost_today` meter where one exists;
where none does, the watts stand alone. There is deliberately no euros-per-hour:
it is a third number that answers neither question and moves under you every time
the appliance cycles.

**A meter line under the room name, but only when the meter is the room's
alone.** Houses are rarely metered room by room — a floor, a circuit, sometimes
one appliance. Give the card a meter that covers only this room (an EV charger on
a driveway) and it names it and shows its draw and spend. Do not give it a floor
meter: printed under each of that floor's rooms it reads as the room's own cost
and triples when you add the rooms up. That figure belongs on the floor heading,
once.

```yaml
meter:
  name: 1st floor
  power: sensor.currentt_1e_power_consumed
  cost_today: sensor.currentt_1e_cost_today
```

## Options

| Option | Default | What |
|---|---|---|
| `area` | — | **Required.** The area id, e.g. `living_room` |
| `name` | the area's name | Header title |
| `climate.radiator` | first `climate` in the area | Fallback thermostat |
| `climate.aircon` | — | A `climate` entity that takes priority when not off |
| `climate.aircon_ir` | — | `{temperature, mode, apply}` for an IR-driven unit |
| `meter` | — | `{name, power, cost_today}` of the meter covering this room |
| `tariff` | see below | €/kWh sensor, used for socket prices |
| `step` | `0.5` | Slider resolution, in degrees |
| `min` / `max` | `15` / `25` | Slider range, clamped by the thermostat's own limits |
| `default_target` | `20` | Where the handle sits when no target is reported |
| `cost_entities` | discovered | `{"Fridge": "sensor.fridge_cost_today"}` overrides |
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
