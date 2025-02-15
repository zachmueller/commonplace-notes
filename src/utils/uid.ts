import { v4 as uuidv4 } from 'uuid';

export function generateUID(): string {
  const u = uuidv4();
  const hexlist = '0123456789abcdef';
  const b64list = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = u.replace(/[^0-9a-f]/ig, '').toLowerCase();
  s += '0';
  let a, p, q;
  let r = '';
  let i = 0;
  while (i < 33) {
    a = (hexlist.indexOf(s.charAt(i++)) << 8) |
      (hexlist.indexOf(s.charAt(i++)) << 4) |
      (hexlist.indexOf(s.charAt(i++)));

    p = a >> 6;
    q = a & 63;

    r += b64list.charAt(p) + b64list.charAt(q);
  }
  return r.replace('/', '_');
}