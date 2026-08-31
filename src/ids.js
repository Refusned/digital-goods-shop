import { randomUUID } from 'node:crypto';

const short = () => randomUUID().replace(/-/g, '').slice(0, 12);

export const newOrderId = () => `ord_${short()}`;
export const newEventId = () => `evt_${short()}`;
