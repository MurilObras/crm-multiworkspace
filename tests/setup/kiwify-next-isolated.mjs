// Preload exclusivo do smoke Next: sem .env real e sem saída para provedores.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
fs.readFileSync = function (file, options) {
  if (/^\.env(?:\.|$)/.test(path.basename(String(file)))) {
    return typeof options === "string" || options?.encoding ? "" : Buffer.alloc(0);
  }
  return read.call(this, file, options);
};
const ports = new Set((process.env.KIWIFY_LOCAL_PORTS || "").split(",").map(Number));
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") ports.add(address.port);
  });
  return listen.apply(this, args);
};
const local = (host, port) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) && ports.has(Number(port));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const option = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (option?.path) return connect.apply(this, args);
  const host = typeof option === "object" ? option.host : args[1];
  const port = typeof option === "object" ? option.port : option;
  if (local(host, port)) return connect.apply(this, args);
  throw new Error("isolated_next_network_denied");
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(input?.url || String(input));
  if (!local(url.hostname, url.port)) return Promise.reject(new Error("isolated_next_network_denied"));
  return fetch(input, ...args);
};
syncBuiltinESMExports();
