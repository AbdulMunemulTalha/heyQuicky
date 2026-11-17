import { createContext, useContext } from 'react';

// The signed-in dashboard: who you are, the shop, permissions, badge counts and shell actions.
export const Dash = createContext(null);
export const useDash = () => useContext(Dash);
