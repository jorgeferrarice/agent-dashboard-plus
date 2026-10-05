import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

let shared: Socket | null = null;

/**
 * Returns the page's single Socket.IO connection to the
 * `/terminal` namespace, creating it on first use.
 *
 * The dashboard and the terminal of the active tab share
 * this connection, so the number of open tabs does not
 * change the number of connections. Consumers must remove
 * their own listeners with `socket.off(event, handler)` and
 * must never call `disconnect()` on it.
 */
export function getSocket(): Socket {
  if (!shared) {
    const baseURL =
      import.meta.env.VITE_API_URL || `http://${window.location.hostname}:8000`;
    shared = io(`${baseURL}/terminal`, { path: '/socket.io' });
  }
  return shared;
}
