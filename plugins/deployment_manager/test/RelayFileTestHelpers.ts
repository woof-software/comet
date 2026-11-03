import fs from 'fs';
import * as path from 'path';

// Keep fixed cache/ paths virtual while leaving all unrelated filesystem operations real.
export function isolateRelayFiles() {
  const directory = path.resolve(__dirname, '../../..', 'cache');
  const files = new Map<string, string>();
  const writes: Array<{ file: string, content: string }> = [];
  const removed: string[] = [];
  const original = {
    existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync,
  };
  const virtualFile = (file: unknown) => path.dirname(String(file)) === directory;
  Object.assign(fs, {
    existsSync: (file: Parameters<typeof fs.existsSync>[0]) =>
      String(file) === directory || (virtualFile(file) ? files.has(String(file)) : original.existsSync(file)),
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) =>
      String(args[0]) === directory ? undefined : original.mkdirSync(...args),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (!virtualFile(args[0])) return original.readFileSync(...args);
      const contents = files.get(String(args[0]));
      if (contents === undefined) throw Object.assign(new Error('Virtual file not found'), { code: 'ENOENT' });
      return contents;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (!virtualFile(args[0])) return original.writeFileSync(...args);
      const file = String(args[0]);
      const content = String(args[1]);
      files.set(file, content);
      writes.push({ file, content });
    },
    unlinkSync: (file: Parameters<typeof fs.unlinkSync>[0]) => {
      if (!virtualFile(file)) return original.unlinkSync(file);
      if (!files.delete(String(file))) throw Object.assign(new Error('Virtual file not found'), { code: 'ENOENT' });
      removed.push(String(file));
    },
  });
  return {
    directory, files, writes, removed,
    file: (name: string) => path.join(directory, name),
    restore: () => { Object.assign(fs, original); },
  };
}
