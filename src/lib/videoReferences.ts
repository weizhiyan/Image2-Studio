export type VideoImageReference =
  | { kind: 'remote'; value: string }
  | { kind: 'local-file'; value: string }
  | { kind: 'data-url'; value: string }
  | { kind: 'unsupported'; value: string };

export function classifyVideoImageReference(value: string): VideoImageReference {
  const url = String(value || '').trim();
  if (/^https:\/\//i.test(url)) return { kind: 'remote', value: url };
  if (url.startsWith('/api/files/')) {
    const encodedName = url.slice('/api/files/'.length).split(/[?#]/, 1)[0];
    try {
      return { kind: 'local-file', value: decodeURIComponent(encodedName) };
    } catch {
      return { kind: 'local-file', value: encodedName };
    }
  }
  if (/^data:image\//i.test(url)) return { kind: 'data-url', value: url };
  return { kind: 'unsupported', value: url };
}
