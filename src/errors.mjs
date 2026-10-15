export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
