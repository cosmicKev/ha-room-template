/*
 * Room Template - one room as one card: how warm it is, what to set it to, the
 * lights, and what the sockets are drawing and costing.
 *
 * A plain custom element rather than a Lit component, so the file that ships is
 * the file that was written: no build step, nothing to compile, and no second
 * copy of Lit fighting the one Home Assistant already loaded.
 *
 * Everything is discovered from the AREA. Entity ids are not parsed for meaning
 * and never constructed - on the install this was written for, the Quooker's
 * power sensor is called `sensor.dryer_power` - so labels come from device names
 * and membership comes from the registry the frontend hands us.
 */

const CARD_VERSION = "1.21.0";

// What a room reports about its own air, in the order it reads in the header.
// CO2 and particulates are here because a room sensor that measures them is
// telling you something about the room, not about the weather - and the ppm is
// the number you act on, so it belongs beside the temperature rather than three
// rows down.
const ENVIRONMENT = ["temperature", "humidity", "carbon_dioxide", "pm25", "pm10"];
// Anything else a plug reports (voltage, current, frequency) is instrumentation,
// not room state.
const SOCKET_CLASS = "power";
/* A metered plug publishes the same watts twice - "Power" and "Instantaneous
 * demand" - and they are not the same number: the demand register is a smoothed
 * or last-interval figure the meter keeps for its own purposes, while Power is
 * what the plug is drawing now. Both carry device_class power, so the first one
 * found wins unless the card has an opinion. It has one, in this order. */
const POWER_PREFERENCE = ["_power", "_active_power", "_instantaneous_demand"];

function powerRank(entityId) {
  const index = POWER_PREFERENCE.findIndex((suffix) => entityId.endsWith(suffix));
  return index === -1 ? POWER_PREFERENCE.length : index;
}
// Things that are appliances rather than plugs. Their own card or dialog owns
// them; their settings switches are not room controls.
const APPLIANCE_DOMAINS = ["vacuum", "lawn_mower", "water_heater", "media_player", "camera"];

/* Price sources, finest block first. The Dutch market settles in quarter hours,
 * so a quarter-hourly sensor beats an hourly average of the same prices. Chosen
 * with a has-value test rather than a sentinel: a dynamic price can legitimately
 * be negative, and -1-means-missing throws away exactly the hours worth
 * noticing. */
const TARIFF_CANDIDATES = [
  "sensor.currentt_pap_import_tariff",
  "sensor.zonneplan_current_quarter_hourly_electricity_tariff",
  "sensor.zonneplan_current_hourly_electricity_tariff",
  "sensor.zonneplan_current_electricity_tariff",
];

// How long the card keeps showing a setpoint the device has not confirmed.
// Long enough for a Matter TRV to answer, short enough that a change made
// somewhere else is not hidden behind it.
const HOLD_MS = 15000;

const DEFAULTS = {
  // Where the handle sits when the thermostat reports no target at all - off,
  // unavailable, or still waking up. Mid-range would be an accident of the
  // range; 20 is a temperature someone chose.
  default_target: 20,
  // The bottom of the travel is off, not a temperature. These radiators report
  // 0 when they are not heating, so the slider starts there and the card turns
  // that into an hvac-mode call - the device would refuse a setpoint of 0, since
  // it advertises a min_temp of 5.
  min: 0,
  max: 25,
  show_climate: true,
  show_lights: true,
  show_sockets: true,
  show_price: true,
  step: 0.5,
};

class RoomTemplate extends HTMLElement {
  static label(friendly, device) {
    if (!device) return friendly;
    if (friendly.toLowerCase().startsWith(device.toLowerCase())) {
      const rest = friendly.slice(device.length).trim();
      if (rest) return rest.charAt(0).toUpperCase() + rest.slice(1);
      return device;
    }
    return friendly || device;
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rendered = "";
    this._held = undefined;
    this.shadowRoot.addEventListener("click", (event) => this._onClick(event));
    // Two listeners, two jobs. `input` fires on every step of the drag and only
    // updates the number on screen - without it the slider is a handle with no
    // idea what it is selecting until you let go. `change` fires once, when the
    // finger lifts, and is the only one that calls a service.
    this.shadowRoot.addEventListener("input", (event) => {
      const slider = event.target.closest('[data-action="target"]');
      if (!slider) return;
      this._hold(Number(slider.value));
      const readout = this.shadowRoot.querySelector('[data-role="target"]');
      if (readout) {
        const value = Number(slider.value);
        readout.textContent = value <= 0.5 ? "Off" : `${value.toFixed(1)}°`;
        readout.classList.toggle("off", value <= 0.5);
        // The readout was written straight into the DOM, so the cached html no
        // longer describes what is on screen. Left as it was, the next render
        // that produced the same string would decide there was nothing to do
        // and leave the hand-written number standing.
        this._rendered = "";
      }
    });
    this.shadowRoot.addEventListener("change", (event) => {
      const slider = event.target.closest('[data-action="target"]');
      if (!slider) return;
      const value = Number(slider.value);
      // Keep holding after the finger lifts. A radiator takes seconds to report
      // the setpoint back - over Matter, sometimes ten - and every state push in
      // between still carries the old number. Without the hold the handle walks
      // back to where it was and the change looks like it was refused.
      this._hold(value);
      this._setTarget(value);
    });
  }

  /** Show `value` on the slider until the device reports it, or the hold ages out.
   *
   * This replaces a `_dragging` flag that gated every render: a range fires
   * `input` for a mouse wheel and for arrow keys, neither of which is followed
   * by a `change` or a `pointerup`, so the flag stuck on and the card stopped
   * redrawing for lights, plugs and everything else. A hold expires by itself,
   * and only ever overrides the one number it is holding.
   */
  _hold(value) {
    this._held = { value, until: Date.now() + HOLD_MS };
    clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(() => {
      this._held = undefined;
      this._render();
    }, HOLD_MS);
  }

  /** The setpoint to draw: what is being asked for, else what the device reports. */
  _heldTarget(reported) {
    const held = this._held;
    if (!held) return reported;
    if (Date.now() > held.until) {
      this._held = undefined;
      return reported;
    }
    // The device has caught up - stop overriding, so a change made elsewhere
    // is not masked by a stale hold.
    if (!isNaN(reported) && Math.abs(reported - held.value) < 0.05) {
      this._held = undefined;
      return reported;
    }
    return held.value;
  }

  static getStubConfig(hass) {
    const area = Object.keys(hass.areas || {})[0];
    return { type: "custom:ha-room-template", area: area || "living_room" };
  }

  setConfig(config) {
    if (!config || !config.area) throw new Error("Set `area` to an area id");
    this._config = { ...DEFAULTS, ...config };
    this._rendered = "";
    this._held = undefined;
    clearTimeout(this._holdTimer);
  }

  getCardSize() {
    return 4;
  }

  set hass(hass) {
    this._hass = hass;
    // Always renders. Nothing suppresses this: a card that skips a state push
    // has no way of knowing to catch up later, and the one thing a drag needs
    // protecting - the number under the finger - is protected by the hold
    // instead, which expires on its own.
    this._render();
  }

  /* ---------------------------------------------------------------- lookup */

  /** Every entity in this room, with the device name that labels it. */
  _entities() {
    const hass = this._hass;
    const entities = hass.entities || {};
    const devices = hass.devices || {};
    const area = this._config.area;
    const found = [];
    for (const [id, entry] of Object.entries(entities)) {
      const device = entry.device_id ? devices[entry.device_id] : undefined;
      const inRoom = entry.area_id === area || (!entry.area_id && device && device.area_id === area);
      if (!inRoom) continue;
      // Hidden and diagnostic entities are the device's internals; the room is
      // what the device DOES.
      if (entry.hidden || entry.disabled_by || entry.entity_category) continue;
      const state = hass.states[id];
      if (!state) continue;
      const deviceName = (device && (device.name_by_user || device.name)) || "";
      const friendly = state.attributes.friendly_name || id;
      found.push({
        id,
        domain: id.split(".")[0],
        state,
        deviceClass: state.attributes.device_class,
        device: deviceName,
        name: friendly,
        // Two ceiling lights on one device are both called "Lights" if you
        // label by device; their own names are "Couch" and "Dinning Table".
        // So: the entity's name, minus the device prefix Home Assistant may
        // have prepended, and the device name only when nothing is left.
        label: RoomTemplate.label(friendly, deviceName),
      });
    }
    return found;
  }

  _areaName() {
    const areas = this._hass.areas || {};
    const area = areas[this._config.area];
    return this._config.name || (area && area.name) || this._config.area;
  }

  /** The room's temperature and humidity: the area's own choice, else the first. */
  _environment(entities) {
    const areas = this._hass.areas || {};
    const area = areas[this._config.area] || {};
    const picked = {};
    for (const kind of ENVIRONMENT) {
      const assigned = area[`${kind}_entity_id`];
      if (assigned && this._hass.states[assigned]) {
        picked[kind] = { id: assigned, state: this._hass.states[assigned] };
        continue;
      }
      // One reading per class - a room may have a radiator and a presence sensor
      // both reporting temperature - and preferably one that is actually
      // reporting. A device that is re-paired leaves its old entities behind as
      // `unavailable`, and picking the first match found meant picking the
      // corpse: the living room lost its humidity that way while a working
      // sensor sat beside it.
      const matches = entities.filter((e) => e.domain === "sensor" && e.deviceClass === kind);
      const live = matches.find((e) => !isNaN(Number(e.state.state)));
      const match = live || matches[0];
      if (match) picked[kind] = match;
    }
    return picked;
  }

  /** Which device the target temperature should be sent to.
   *
   * An air conditioner wins wherever one exists: it is cheaper to run than the
   * radiators. None is installed on the house this was written for, so the
   * radiator path is the one that runs and the aircon path is configuration
   * waiting for hardware - either a climate entity of its own, or the
   * helper-and-script route an IR-driven unit needs.
   */
  _thermostat(entities) {
    const config = this._config.climate || {};
    const hass = this._hass;

    if (config.aircon && hass.states[config.aircon]) {
      const state = hass.states[config.aircon];
      if (state.state !== "off" && state.state !== "unavailable") {
        return { kind: "climate", entity: config.aircon, label: "Airco", state };
      }
    }
    const ir = config.aircon_ir;
    if (ir && hass.states[ir.temperature]) {
      const mode = ir.mode ? hass.states[ir.mode] : undefined;
      if (!mode || (mode.state !== "off" && mode.state !== "unavailable")) {
        return {
          kind: "ir",
          entity: ir.temperature,
          apply: ir.apply,
          label: "Airco",
          state: hass.states[ir.temperature],
        };
      }
    }
    const radiator =
      (config.radiator && hass.states[config.radiator] && config.radiator) ||
      (entities.find((e) => e.domain === "climate") || {}).id;
    if (radiator) {
      return { kind: "climate", entity: radiator, label: "Radiator", state: hass.states[radiator] };
    }
    return undefined;
  }

  /** What covers this room, in the meter's own words.
   *
   * Only worth showing when the meter covers THIS room and nothing else - the
   * EV charger on the driveway, say. A floor meter printed under each of its
   * rooms reads as that room's cost and triples when you add the rooms up; that
   * figure belongs on the floor, once.
   */
  _meterFooter() {
    const meter = this._config.meter;
    if (!meter) return "";
    const parts = [];
    const power = meter.power && this._hass.states[meter.power];
    if (power && !isNaN(Number(power.state))) {
      parts.push(`${Math.round(Number(power.state))} W`);
    }
    const cost = meter.cost_today && this._hass.states[meter.cost_today];
    if (cost && !isNaN(Number(cost.state))) {
      parts.push(`€${Number(cost.state).toFixed(2)} today`);
    }
    if (!parts.length) return "";
    const label = meter.name ? `${this._esc(meter.name)} · ` : "";
    // Under the room's name rather than at the foot of the card: it is a fact
    // about this room, and the eye reads it on the way past instead of having
    // to travel to the bottom for it.
    return `<div class="sub">${label}${this._esc(parts.join(" · "))}</div>`;
  }

  _tariff() {
    const candidates = [this._config.tariff, ...TARIFF_CANDIDATES].filter(Boolean);
    for (const id of candidates) {
      const state = this._hass.states[id];
      if (state && !isNaN(Number(state.state))) return Number(state.state);
    }
    return undefined;
  }

  /** What this plug has cost today, if anything is keeping that total.
   *
   * The per-plug euro meters are generated from the plug-to-meter links (see
   * scripts/apply_socket_links.py in the house repo) and are named after the
   * device: "Fridge" -> `sensor.fridge_cost_today`. Nothing to configure, and
   * nothing shown when the total does not exist.
   */
  _costToday(socket) {
    const configured = (this._config.cost_entities || {})[socket.device];
    const slug = socket.device
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    for (const id of [configured, `sensor.${slug}_cost_today`]) {
      if (!id) continue;
      const state = this._hass.states[id];
      if (state && !isNaN(Number(state.state))) return Number(state.state);
    }
    return undefined;
  }

  /** Metered plugs: the switch to press, or the reading when there is none.
   *
   * An appliance that owns its own domain entity is not a socket, whatever
   * switches it exposes: a robot vacuum publishes a dozen setting toggles, and
   * the first one found was appearing in the room as a plug named after the
   * robot, with no power behind it.
   */
  _sockets(entities) {
    const appliances = new Set(
      entities
        .filter((e) => APPLIANCE_DOMAINS.includes(e.domain) && e.device)
        .map((e) => e.device)
    );
    const byDevice = new Map();
    for (const entity of entities) {
      if (appliances.has(entity.device)) continue;
      // A switch defined in YAML - wake-on-LAN, a template, a command_line -
      // belongs to no device at all, and keying only on device names dropped it
      // silently. Its own entity id is the key then, and its own name the label.
      const key = entity.device || entity.id;
      const socket = byDevice.get(key) || { device: entity.device || entity.label };
      if (entity.domain === "switch" && !socket.switch) socket.switch = entity;
      if (entity.domain === "sensor" && entity.deviceClass === SOCKET_CLASS) {
        // A reading that reports beats a better-named one that does not.
        const live = !isNaN(Number(entity.state.state));
        const heldLive = socket.power && !isNaN(Number(socket.power.state.state));
        const better = !socket.power
          || (live && !heldLive)
          || (live === heldLive && powerRank(entity.id) < powerRank(socket.power.id));
        if (better) socket.power = entity;
      }
      byDevice.set(key, socket);
    }
    return [...byDevice.values()].filter((socket) => socket.power || socket.switch);
  }

  /* --------------------------------------------------------------- actions */

  _setTarget(temperature) {
    const thermostat = this._thermostat(this._entities());
    if (!thermostat || isNaN(temperature)) return;
    const value = Math.round(temperature * 2) / 2;

    // The bottom of the slider is off. Sending 0 as a setpoint would be refused
    // by a device whose min_temp is 5, so it goes as a mode change instead.
    if (thermostat.kind === "climate" && value <= 0.5) {
      this._hass.callService("climate", "set_hvac_mode", {
        entity_id: thermostat.entity,
        hvac_mode: "off",
      });
      return;
    }

    if (thermostat.kind === "ir") {
      this._hass.callService("input_number", "set_value", {
        entity_id: thermostat.entity,
        value,
      });
      // The helper is only a number until the script sends the code.
      if (thermostat.apply) {
        const [domain, service] = thermostat.apply.split(".");
        this._hass.callService(domain, service, {});
      }
      return;
    }

    // Setting a temperature on a thermostat that is off does nothing on most
    // integrations - the setpoint lands and the valve stays shut - so asking for
    // a temperature turns it on first, using whatever heating mode it offers.
    if (thermostat.state.state === "off") {
      const modes = thermostat.state.attributes.hvac_modes || [];
      const mode = ["heat", "auto", "heat_cool"].find((m) => modes.includes(m));
      if (mode) {
        this._hass.callService("climate", "set_hvac_mode", {
          entity_id: thermostat.entity,
          hvac_mode: mode,
        });
      }
    }
    this._hass.callService("climate", "set_temperature", {
      entity_id: thermostat.entity,
      temperature: value,
    });
  }

  _onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, value } = target.dataset;
    if (action === "heat-toggle") {
      const thermostat = this._thermostat(this._entities());
      if (thermostat && thermostat.kind === "climate") {
        const state = thermostat.state;
        const target = Number(state.attributes.temperature);
        const isOff = state.state === "off" || target <= 0.5;
        const modes = state.attributes.hvac_modes || [];
        const heating = ["heat", "auto", "heat_cool"].find((m) => modes.includes(m));
        this._hass.callService("climate", "set_hvac_mode", {
          entity_id: thermostat.entity,
          hvac_mode: isOff ? heating || "heat" : "off",
        });
      }
      return;
    }
    if (action === "toggle") {
      this._hass.callService("homeassistant", "toggle", { entity_id: value });
    }
    if (action === "more-info") {
      this.dispatchEvent(
        new CustomEvent("hass-more-info", {
          detail: { entityId: value },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  /* ---------------------------------------------------------------- render */

  _esc(value) {
    return String(value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _number(value, digits = 1) {
    const parsed = Number(value);
    return isNaN(parsed) ? undefined : parsed.toFixed(digits);
  }

  _render() {
    if (!this._hass || !this._config) return;
    const entities = this._entities();
    const config = this._config;

    const environment = this._environment(entities);
    const badges = ENVIRONMENT.map((kind) => {
      const reading = environment[kind];
      if (!reading) return "";
      const unit = reading.state.attributes.unit_of_measurement || "";
      const value = this._number(reading.state.state, kind === "temperature" ? 1 : 0);
      if (value === undefined) return "";
      // Stale air is the one reading worth colouring: 1000 ppm is where advice
      // everywhere says open a window, 1400 where it starts costing you.
      const ppm = kind === "carbon_dioxide" ? Number(reading.state.state) : NaN;
      const warn = !isNaN(ppm) && ppm >= 1400 ? " bad" : !isNaN(ppm) && ppm >= 1000 ? " warn" : "";
      return `<span class="badge${warn}" data-action="more-info" data-value="${this._esc(reading.id)}">
                ${this._esc(value)}${this._esc(unit)}</span>`;
    }).join("");

    const rows = [];
    let sliderPosition;

    const thermostat = config.show_climate ? this._thermostat(entities) : undefined;
    if (thermostat) {
      const reported =
        thermostat.kind === "ir"
          ? Number(thermostat.state.state)
          : Number(thermostat.state.attributes.temperature);
      const target = this._heldTarget(reported);
      // A radiator that has dropped off the network reports no setpoint at all.
      // Drawing the configured default there invents a number the device never
      // held - which is what made a refresh look like it reset every radiator to
      // 20 - so the row says so instead and the slider does not pretend to be
      // driving anything.
      const gone = thermostat.state.state === "unavailable"
        || thermostat.state.state === "unknown"
        || isNaN(target);
      const current =
        thermostat.kind === "climate"
          ? this._number(thermostat.state.attributes.current_temperature)
          : undefined;
      // A slider rather than a pair of arrows: setting 21.5 from 18 is one drag
      // instead of seven presses, and the position itself says where in the
      // range the room is set.
      // The top is capped by what the device accepts; the bottom is not, because
      // below its min_temp lies off, which the card sends as a mode rather than
      // as a temperature.
      const deviceMax = Number(thermostat.state.attributes.max_temp);
      const min = Number(config.min);
      const max = Math.min(Number(config.max), isNaN(deviceMax) ? Infinity : deviceMax);
      const step = Number(config.step) || 0.5;
      // A thermostat that is off has no target worth printing: showing 20 there
      // claims a setpoint it is not holding. The handle parks at the bottom of
      // the band so dragging it up is the natural way to ask for heat.
      // Off has two spellings on these radiators: the hvac mode, and a target
      // of 0 - which is what a Tado TRV reports when it is not heating at all,
      // regardless of the min_temp it advertises.
      const off = thermostat.kind === "climate"
        && (thermostat.state.state === "off" || target <= 0.5);
      // The handle sits on the setpoint the device is actually holding, off or
      // not. Parking it at the bottom whenever the mode was `off` threw the
      // stored temperature away: these TRVs sit at `off` with a perfectly good
      // 15 or 25 behind them, and every refresh dragged the handle back down to
      // the floor. Off is said by the readout and the power button, which is
      // where it belongs - the slider's job is to show the number.
      const fallback = Number(config.default_target);
      const position = gone ? fallback : isNaN(target) ? fallback : target;
      const shown = gone
        ? "—"
        : `${position.toFixed(1)}°`;
      sliderPosition = position;
      rows.push(`
        <div class="thermostat">
          <div class="label">
            <div class="title">${this._esc(thermostat.label)}</div>
            <div class="sub">${
              gone ? "offline" : current !== undefined ? `now ${this._esc(current)}°` : "target"
            }</div>
          </div>
          <input class="slider" type="range" data-action="target"
                 min="${min}" max="${max}" step="${step}"
                 value="${position}"${gone ? " disabled" : ""}>
          <div class="target${off || gone ? " off" : ""}" data-role="target">${this._esc(shown)}</div>
          <button class="power${off || gone ? "" : " on"}" data-action="heat-toggle"
                  ${gone ? "disabled" : ""}
                  title="${off ? "Turn heating on" : "Turn heating off"}">
            <ha-icon icon="mdi:power"></ha-icon>
          </button>
        </div>`);
    }

    const applianceDevices = new Set(
      entities
        .filter((e) => APPLIANCE_DOMAINS.includes(e.domain) && e.device)
        .map((e) => e.device)
    );
    const lights = config.show_lights
      ? entities.filter((e) => e.domain === "light" && !applianceDevices.has(e.device))
      : [];
    if (lights.length) {
      rows.push(`<div class="grid">
        ${lights
          .map((light) => {
            const on = light.state.state === "on";
            const brightness = light.state.attributes.brightness;
            const detail = on && brightness ? `${Math.round(brightness / 2.55)}%` : on ? "On" : "Off";
            return `<button class="chip${on ? " active" : ""}" data-action="toggle" data-value="${this._esc(light.id)}">
                      <ha-icon icon="mdi:lightbulb"></ha-icon>
                      <span class="chip-name">${this._esc(light.label)}</span>
                      <span class="chip-sub">${this._esc(detail)}</span>
                    </button>`;
          })
          .join("")}
      </div>`);
    }

    const tariff = this._tariff();
    const sockets = config.show_sockets ? this._sockets(entities) : [];
    if (sockets.length) {
      rows.push(`<div class="grid">
        ${sockets
          .map((socket) => {
            const watts = socket.power ? Number(socket.power.state.state) : undefined;
            const reading = isNaN(watts) || watts === undefined ? "" : `${Math.round(watts)} W`;
            // Two questions on one line: what it is drawing NOW, and what it has
            // spent since midnight. No euros-per-hour - an hourly rate is a
            // third thing that answers neither, and it changes under you as the
            // appliance cycles. Where no daily total is kept, the watts stand
            // alone rather than being padded with a rate.
            // The day's spend in brackets after the watts: "84 W (€0.31)". One
            // line, two facts, and the brackets say the euros are the total so
            // far rather than anything happening right now.
            const spent = this._costToday(socket);
            const cost = spent !== undefined ? `(€${spent.toFixed(2)})` : "";
            const label = this._esc(socket.device);
            if (socket.switch) {
              const on = socket.switch.state.state === "on";
              return `<button class="chip${on ? " active" : ""}" data-action="toggle" data-value="${this._esc(socket.switch.id)}">
                        <ha-icon icon="mdi:power-socket-de"></ha-icon>
                        <span class="chip-name">${label}</span>
                        <span class="chip-sub">${this._esc([reading, cost].filter(Boolean).join(" "))}</span>
                      </button>`;
            }
            // No switch: some plugs are deliberately not switchable from a
            // dashboard (a fridge, a boiling-water tap). A reading, then -
            // full weight, not dimmed: it is not a control that failed.
            return `<div class="chip reading" data-action="more-info" data-value="${this._esc(socket.power.id)}">
                      <ha-icon icon="mdi:flash"></ha-icon>
                      <span class="chip-name">${label}</span>
                      <span class="chip-sub">${this._esc([reading, cost].filter(Boolean).join(" "))}</span>
                    </div>`;
          })
          .join("")}
      </div>`);
    }

    // The footer belongs to whatever actually meters this room, which is rarely
    // the room. Metering here is by floor - and a few appliances sit on meters
    // of their own - so the card is told which meter covers it rather than
    // guessing, and says so by name. A house-wide tariff repeated under every
    // room read as if it were that room's price, which it never was.
    const price = config.show_price ? this._meterFooter() : "";

    const html = `
      <ha-card>
        <div class="head">
          <div class="identity">
            <div class="name">${this._esc(this._areaName())}</div>
            ${price}
          </div>
          <div class="badges">${badges}</div>
        </div>
        <div class="body">${rows.join("")}</div>
      </ha-card>`;

    if (html === this._rendered) return;
    this._rendered = html;
    this.shadowRoot.innerHTML = `<style>${RoomTemplate.styles}</style>${html}`;
    // `value` on a range is the attribute's default, not its value, and the two
    // part company the moment anything touches the control. Writing the property
    // after the markup keeps the handle on what the state says.
    const slider = this.shadowRoot.querySelector('[data-action="target"]');
    if (slider && sliderPosition !== undefined) slider.value = String(sliderPosition);
  }
}

RoomTemplate.styles = `
  :host { display: block; }
  /* An explicit edge, not the theme's ha-card-border-width: this house sets that
     to 0, so cards float with no outline at all - fine for a single tile, wrong
     for a card that is a container of other cards. The colour still follows the
     theme. */
  ha-card {
    padding: 12px 14px 14px;
    border: 1px solid var(--ha-card-border-color, var(--divider-color));
  }
  /* The header and its rule are exactly one chip tall, so the first row of
     controls starts at the same height on every card in a floor - and a card
     with a long room name does not push its buttons out of line with the card
     beside it. */
  .head {
    display: flex; align-items: center; gap: 10px;
    min-height: 78px; box-sizing: border-box;
    padding-bottom: 10px; margin-bottom: 12px;
    border-bottom: 1px solid var(--divider-color);
  }
  .identity { flex: 1; min-width: 0; }
  .name {
    font-size: 20px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .head .sub {
    font-size: 12px; color: var(--secondary-text-color);
    margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Same on a narrow screen: the readings stay on the card, the room name gives
     way. A card with five badges - temperature, humidity, CO2, PM - has more to
     lose here than the vacuum does. */
  .badges { display: flex; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }
  .badge {
    font-size: 15px; color: var(--secondary-text-color);
    background: var(--secondary-background-color);
    border-radius: 999px; padding: 3px 10px; cursor: pointer;
  }
  .body { display: flex; flex-direction: column; gap: 8px; }
  /* auto-fit rather than a fixed column count: two buttons are two halves, four
     wrap onto a second row and stretch to fill it, and nothing is ever left as a
     narrow stub beside empty space. */
  .grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
  .thermostat {
    display: flex; align-items: center; gap: 12px;
    background: var(--secondary-background-color);
    border-radius: 12px; padding: 10px 12px;
  }
  /* Two chips tall, plus the gap between them: the card is built from one
     module - a 78px chip - and the thermostat is the only block that is not a
     row of them, so it is sized as two rather than as whatever its contents
     came to. Everything then lines up down the card and across the floor. */
  /* One chip tall, like every other row. Two was more room than a slider and
     two numbers need, and it left a radiator standing twice as tall as the
     lights beside it. The min/max scale went with the second row: the ends of
     the travel are 15 and 25 on every card here, and the number under the
     thumb says where you are. */
  .thermostat {
    flex-direction: row; align-items: center; gap: 12px;
    height: 78px; box-sizing: border-box;
  }
  .thermostat .label { flex: 0 0 auto; min-width: 84px; }
  .thermostat .title { font-size: 13px; font-weight: 600; }
  .thermostat .sub { font-size: 12px; color: var(--secondary-text-color); }
  .slider { flex: 1; }
  .target { font-size: 22px; font-weight: 700; min-width: 68px; text-align: right; }
  .target.off { color: var(--secondary-text-color); font-size: 20px; }
  .power {
    flex: 0 0 auto; width: 34px; height: 34px; border: none; border-radius: 999px;
    background: var(--card-background-color); color: var(--secondary-text-color);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: transform 90ms ease, color 120ms ease;
  }
  .power ha-icon { --mdc-icon-size: 20px; }
  .power.on { color: var(--primary-color); }
  .power:active { transform: scale(0.94); }
  .slider {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 10px; border-radius: 999px; margin: 0;
    background: var(--card-background-color);
    cursor: pointer;
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 26px; height: 26px; border-radius: 999px;
    background: var(--primary-color); border: none; cursor: grab;
  }
  .slider::-moz-range-thumb {
    width: 26px; height: 26px; border-radius: 999px;
    background: var(--primary-color); border: none; cursor: grab;
  }

  .chip {
    /* A fixed height, not a minimum: a plug with a cost line was taller than one
       without, so a row of them stepped up and down. The sub line is always
       rendered, empty when there is nothing to say, which keeps the icon and the
       name on the same baseline across every chip on every card. */
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; height: 78px; box-sizing: border-box; padding: 8px 6px;
    border: 1px solid transparent; border-radius: 12px;
    background: var(--secondary-background-color);
    color: var(--primary-text-color);
    font-family: inherit; font-size: 12px; font-weight: 600;
    cursor: pointer; text-align: center;
    transition: transform 90ms ease, border-color 120ms ease, color 120ms ease;
  }
  .chip ha-icon { --mdc-icon-size: 20px; color: var(--state-icon-color, var(--secondary-text-color)); }
  .chip:active { transform: scale(0.97); }
  .chip.active { border-color: var(--primary-color); color: var(--primary-color); }
  .chip.active ha-icon { color: var(--primary-color); }
  /* A reading is not a disabled control. Dimming it said "this is broken" about
     a fridge that is working perfectly and simply has no switch to offer, so it
     carries the same weight as everything else - it just does not light up,
     because there is no state to be in. */
  .chip.reading { cursor: pointer; }
  .chip-name { line-height: 1.2; }
  .chip-sub {
    font-size: 11px; font-weight: 500; color: var(--secondary-text-color);
    min-height: 13px; line-height: 13px;
  }
  .grid { align-items: stretch; }

`;

customElements.define("ha-room-template", RoomTemplate);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-room-template",
  name: "Room Template",
  description: "One room as one card: climate, lights, and what the sockets draw and cost.",
  preview: true,
  documentationURL: "https://github.com/cosmicKev/ha-room-template",
});

console.info(`%c ROOM-TEMPLATE %c ${CARD_VERSION} `,
  "color: white; background: #555; font-weight: 700;",
  "color: #555; background: white;");
