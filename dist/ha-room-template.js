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

const CARD_VERSION = "1.1.1";

const ENVIRONMENT = ["temperature", "humidity"];
// Anything else a plug reports (voltage, current, frequency) is instrumentation,
// not room state.
const SOCKET_CLASS = "power";

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

const DEFAULTS = {
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
    this.shadowRoot.addEventListener("click", (event) => this._onClick(event));
    // `change` rather than `input`: one service call when the finger lifts, not
    // one per pixel of drag.
    this.shadowRoot.addEventListener("change", (event) => {
      const slider = event.target.closest('[data-action="target"]');
      if (slider) this._setTarget(Number(slider.value));
    });
  }

  static getStubConfig(hass) {
    const area = Object.keys(hass.areas || {})[0];
    return { type: "custom:ha-room-template", area: area || "living_room" };
  }

  setConfig(config) {
    if (!config || !config.area) throw new Error("Set `area` to an area id");
    this._config = { ...DEFAULTS, ...config };
    this._rendered = "";
  }

  getCardSize() {
    return 4;
  }

  set hass(hass) {
    this._hass = hass;
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
      // One reading per class: rooms here have a radiator and a presence sensor
      // both reporting temperature, and one device reports humidity twice.
      const match = entities.find((e) => e.domain === "sensor" && e.deviceClass === kind);
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

  /** Metered plugs: the switch to press, or the reading when there is none. */
  _sockets(entities) {
    const byDevice = new Map();
    for (const entity of entities) {
      if (!entity.device) continue;
      const socket = byDevice.get(entity.device) || { device: entity.device };
      if (entity.domain === "switch" && !socket.switch) socket.switch = entity;
      if (entity.domain === "sensor" && entity.deviceClass === SOCKET_CLASS && !socket.power) {
        socket.power = entity;
      }
      byDevice.set(entity.device, socket);
    }
    return [...byDevice.values()].filter((socket) => socket.power || socket.switch);
  }

  /* --------------------------------------------------------------- actions */

  _setTarget(temperature) {
    const thermostat = this._thermostat(this._entities());
    if (!thermostat || isNaN(temperature)) return;
    const value = Math.round(temperature * 2) / 2;

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

    this._hass.callService("climate", "set_temperature", {
      entity_id: thermostat.entity,
      temperature: value,
    });
  }

  _onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, value } = target.dataset;
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
      return `<span class="badge" data-action="more-info" data-value="${this._esc(reading.id)}">
                ${this._esc(value)}${this._esc(unit)}</span>`;
    }).join("");

    const rows = [];

    const thermostat = config.show_climate ? this._thermostat(entities) : undefined;
    if (thermostat) {
      const target =
        thermostat.kind === "ir"
          ? Number(thermostat.state.state)
          : Number(thermostat.state.attributes.temperature);
      const current =
        thermostat.kind === "climate"
          ? this._number(thermostat.state.attributes.current_temperature)
          : undefined;
      // A slider rather than a pair of arrows: setting 21.5 from 18 is one drag
      // instead of seven presses, and the position itself says where in the
      // range the room is set.
      const min = Number(
        thermostat.kind === "climate" ? thermostat.state.attributes.min_temp ?? 5 : config.min ?? 5
      );
      const max = Number(
        thermostat.kind === "climate" ? thermostat.state.attributes.max_temp ?? 30 : config.max ?? 30
      );
      const step = Number(config.step) || 0.5;
      const shown = isNaN(target) ? "—" : `${target.toFixed(1)}°`;
      rows.push(`
        <div class="thermostat">
          <div class="head-row">
            <div class="label">
              <div class="title">Target</div>
              <div class="sub">${this._esc(thermostat.label)}${
                current !== undefined ? ` · now ${this._esc(current)}°` : ""
              }</div>
            </div>
            <div class="target">${this._esc(shown)}</div>
          </div>
          <input class="slider" type="range" data-action="target"
                 min="${min}" max="${max}" step="${step}"
                 value="${isNaN(target) ? (min + max) / 2 : target}">
          <div class="scale"><span>${min}°</span><span>${max}°</span></div>
        </div>`);
    }

    const lights = config.show_lights ? entities.filter((e) => e.domain === "light") : [];
    if (lights.length) {
      rows.push(`<div class="grid" style="grid-template-columns: repeat(${Math.min(lights.length, 3)}, minmax(0, 1fr))">
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
      rows.push(`<div class="grid" style="grid-template-columns: repeat(${Math.min(sockets.length, 3)}, minmax(0, 1fr))">
        ${sockets
          .map((socket) => {
            const watts = socket.power ? Number(socket.power.state.state) : undefined;
            const reading = isNaN(watts) || watts === undefined ? "" : `${Math.round(watts)} W`;
            // Two questions on one line: what it is drawing NOW, and what it has
            // spent since midnight. No euros-per-hour - an hourly rate is a
            // third thing that answers neither, and it changes under you as the
            // appliance cycles. Where no daily total is kept, the watts stand
            // alone rather than being padded with a rate.
            const spent = this._costToday(socket);
            const cost = spent !== undefined ? `€${spent.toFixed(2)} today` : "";
            const label = this._esc(socket.device);
            if (socket.switch) {
              const on = socket.switch.state.state === "on";
              return `<button class="chip${on ? " active" : ""}" data-action="toggle" data-value="${this._esc(socket.switch.id)}">
                        <ha-icon icon="mdi:power-socket-de"></ha-icon>
                        <span class="chip-name">${label}</span>
                        <span class="chip-sub">${this._esc([reading, cost].filter(Boolean).join(" · "))}</span>
                      </button>`;
            }
            // No switch: some plugs here are deliberately not switchable from a
            // dashboard (the fridge, the Quooker). A reading, then - greyed, so
            // it does not read as a control that failed.
            return `<div class="chip reading" data-action="more-info" data-value="${this._esc(socket.power.id)}">
                      <ha-icon icon="mdi:flash"></ha-icon>
                      <span class="chip-name">${label}</span>
                      <span class="chip-sub">${this._esc([reading, cost].filter(Boolean).join(" · "))}</span>
                    </div>`;
          })
          .join("")}
      </div>`);
    }

    const price =
      config.show_price && tariff !== undefined
        ? `<div class="price">Now €${tariff.toFixed(2)}/kWh</div>`
        : "";

    const html = `
      <ha-card>
        <div class="head">
          <div class="name">${this._esc(this._areaName())}</div>
          <div class="badges">${badges}</div>
        </div>
        <div class="body">${rows.join("")}</div>
        ${price}
      </ha-card>`;

    if (html === this._rendered) return;
    this._rendered = html;
    this.shadowRoot.innerHTML = `<style>${RoomTemplate.styles}</style>${html}`;
  }
}

RoomTemplate.styles = `
  :host { display: block; }
  ha-card { padding: 12px 14px 14px; }
  .head {
    display: flex; align-items: center; gap: 10px;
    padding-bottom: 10px; margin-bottom: 12px;
    border-bottom: 1px solid var(--divider-color);
  }
  .name { font-size: 20px; font-weight: 600; flex: 1; }
  .badges { display: flex; gap: 6px; }
  .badge {
    font-size: 15px; color: var(--secondary-text-color);
    background: var(--secondary-background-color);
    border-radius: 999px; padding: 3px 10px; cursor: pointer;
  }
  .body { display: flex; flex-direction: column; gap: 8px; }
  .grid { display: grid; gap: 8px; }
  .thermostat {
    display: flex; align-items: center; gap: 12px;
    background: var(--secondary-background-color);
    border-radius: 12px; padding: 10px 12px;
  }
  .thermostat { flex-direction: column; align-items: stretch; gap: 8px; }
  .thermostat .head-row { display: flex; align-items: center; gap: 12px; }
  .thermostat .label { flex: 1; }
  .thermostat .title { font-size: 13px; font-weight: 600; }
  .thermostat .sub { font-size: 12px; color: var(--secondary-text-color); }
  .target { font-size: 24px; font-weight: 700; min-width: 74px; text-align: center; }
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
  .scale {
    display: flex; justify-content: space-between;
    font-size: 11px; color: var(--secondary-text-color);
  }
  .chip {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; min-height: 74px; padding: 8px 6px;
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
  .chip.reading { color: var(--secondary-text-color); opacity: 0.75; cursor: pointer; }
  .chip-name { line-height: 1.2; }
  .chip-sub { font-size: 11px; font-weight: 500; color: var(--secondary-text-color); }
  .price {
    margin-top: 10px; text-align: right;
    font-size: 12px; color: var(--secondary-text-color);
  }
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
