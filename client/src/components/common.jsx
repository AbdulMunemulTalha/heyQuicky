import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { initials, importLabel } from '../format.js';

// A native <dialog> shown as a modal while `open` is true. Escape and the
// close button call onClose; children only render while open.
export function Modal({ open, onClose, className = '', closeLabel = 'Close', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className={className} onClose={onClose}>
      <form method="dialog" className="dialog-close"><button className="ghost">{closeLabel}</button></form>
      {open && children}
    </dialog>
  );
}

// A round avatar with the customer's initials and a dot for the app they wrote on.
export function Avatar({ conversation: c, className = '' }) {
  const text = initials(c.contact_name) || (c.platform === 'whatsapp' ? '#' : '?');
  return (
    <span className={`avatar ${className}`} aria-hidden="true">
      {text}<i className={`dot ${c.platform}`} />
    </span>
  );
}

export function ImportStatus({ channel }) {
  const label = importLabel(channel);
  return label ? <div className="small"><span className={label.className}>{label.text}</span></div> : null;
}

export function ErrorText({ children, className = 'error' }) {
  return children ? <p className={className}>{children}</p> : null;
}

// Real-time events from the server, with automatic unsubscribe.
export const SocketContext = createContext(null);

export function useSocketEvent(event, handler) {
  const socket = useContext(SocketContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!socket) return undefined;
    const listener = (...args) => latest.current(...args);
    socket.on(event, listener);
    return () => socket.off(event, listener);
  }, [socket, event]);
}

// Shared state for connecting Facebook/Instagram/WhatsApp from Settings or onboarding.
export const ConnectContext = createContext(null);

export function useConnect() {
  return useContext(ConnectContext);
}

// "Connect with Facebook" / WhatsApp buttons; each disables itself while busy.
// Both open the connect popup (see ConnectFlow), which walks through the rest.
export function FacebookButton({ className = 'brand-facebook', kind = 'facebook', children }) {
  const { open } = useConnect();
  return <button type="button" className={className} onClick={() => open(kind)}>{children}</button>;
}

export function WhatsAppButton({ mode, className, children }) {
  const { open } = useConnect();
  return <button type="button" className={className} onClick={() => open('whatsapp', { mode })}>{children}</button>;
}
