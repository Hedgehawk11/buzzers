// PlayroomKit stub: in-memory state, RPC registry, fake participants.
export const _store = {
  state: {},
  rpc: {},
  participants: {},
  self: null,
  nextSender: null,
  isHost: true,
  roomCode: "TEST",
};

export function getState(key) {
  return _store.state[key];
}
export function setState(key, value) {
  _store.state[key] = value;
}
export function isHost() {
  return _store.isHost;
}
export function me() {
  return _store.self;
}
export function getParticipants() {
  return _store.participants;
}
export function getRoomCode() {
  return _store.roomCode;
}
export async function insertCoin() {
  return true;
}
export const RPC = {
  Mode: { HOST: "host" },
  register(name, fn) {
    _store.rpc[name] = fn;
  },
  async call(name, payload, _mode) {
    const sender = _store.nextSender || _store.self;
    return _store.rpc[name](payload, sender);
  },
};

export function makePlayer(id, name, clientMode = "player") {
  const states = { displayName: name, clientMode };
  return {
    id,
    _states: states,
    getState(k) {
      return this._states[k];
    },
    setState(k, v) {
      this._states[k] = v;
    },
    getProfile() {
      return { name };
    },
  };
}
