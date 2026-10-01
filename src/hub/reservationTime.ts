export const reservationWindowStart = (now = Date.now()) => Math.floor(now / 1800000) * 1800000
