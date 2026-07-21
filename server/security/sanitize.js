function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const nick = raw.trim().replace(/\s+/g, ' ').slice(0, 20);
  if (nick.length < 2) return null;
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(nick)) return null;
  return nick;
}

function sanitizeAction(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/\s+/g, ' ').slice(0, 400);
  if (text.length < 1) return null;
  return text;
}

function sanitizePartyCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return code.length >= 4 ? code : null;
}

module.exports = { sanitizeNickname, sanitizeAction, sanitizePartyCode };
