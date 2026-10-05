export function safeDisplayFilename(value: string): string {
  let wellFormed = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        wellFormed += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    wellFormed += value[index];
  }
  const normalized = wellFormed.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  return Array.from(normalized || 'download').slice(0, 255).join('');
}

export function contentDisposition(filename: string): string {
  const safeName = safeDisplayFilename(filename);
  const fallback = safeName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'download';
  const encoded = encodeURIComponent(safeName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
