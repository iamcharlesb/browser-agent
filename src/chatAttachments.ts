/** Clipboard/file attachments are stored locally and referenced by opaque IDs, not put in history as base64. */
import { buildCodeIndex, CodeIndex } from './codeIndex';
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareProjectFiles, ProjectSourceFile } from "./projectAttachments";
import { artifactUrlFor } from "./apiContract";
export interface ChatAttachment { id: string; name: string; type: 'image'|'text'|'project'; projectFiles?: ProjectSourceFile[]; codeIndex?: CodeIndex; indexRevision?: string; fileCount?: number; skipped?: number; filename?: string; mime?: string; text?: string; size: number; url?: string }
export async function storeChatAttachment(base: string, artifacts: string, raw: Record<string,unknown>): Promise<ChatAttachment> {
  const id=randomUUID(),name=String(raw.name||'Pasted image').slice(0,160);
  let attachment: ChatAttachment;
  await mkdir(base,{recursive:true});
  if (Array.isArray(raw.projectFiles)) {
    const project = prepareProjectFiles(raw.projectFiles);
    const clientSkipped = Number.isSafeInteger(raw.skipped) && Number(raw.skipped) > 0 ? Math.min(Number(raw.skipped), 1000000) : 0;
    attachment = { id, name, type: 'project', ...project, codeIndex: buildCodeIndex(project.projectFiles), fileCount: project.projectFiles.length, skipped: project.skipped + clientSkipped };
    attachment.indexRevision = attachment.codeIndex!.revision;
  } else if(typeof raw.dataUrl==='string') {
    const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(raw.dataUrl);
    if(!match)throw new Error('Use PNG, JPEG, WebP or GIF images.');
    const bytes=Buffer.from(match[2],'base64');
    if(!bytes.length||bytes.length>3*1024*1024)throw new Error('Each image must be at most 3 MB.');
    const magic = match[1]==='image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1]==='image/jpeg' ? bytes[0]===255&&bytes[1]===216 : match[1]==='image/gif' ? /^GIF8[79]a/.test(bytes.subarray(0,6).toString()) : bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!magic)throw new Error('The image content does not match its file type.');
    const filename=`attachment-${id}.${match[1].split('/')[1]==='jpeg'?'jpg':match[1].split('/')[1]}`;
    await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,filename),bytes,{mode:0o600});
    attachment={id,name,type:'image',filename,mime:match[1],size:bytes.length,url:artifactUrlFor(filename)};
  } else {
    const text=typeof raw.text==='string'?raw.text:'';
    if(!text.trim()||Buffer.byteLength(text)>200000)throw new Error('Text attachments must contain 1–200 KB of text.');
    attachment={id,name,type:'text',text,size:Buffer.byteLength(text)};
  }
  await writeFile(join(base,`${id}.json`),JSON.stringify(attachment),{mode:0o600});return attachment;
}
export async function loadChatAttachments(base: string, task: string): Promise<ChatAttachment[]> {
  const ids=[...new Set([...task.matchAll(/\[attachment: ([0-9a-f-]{36})\]/g)].map(m=>m[1]))].slice(0,8);
  return Promise.all(ids.map(async id => {
    const filename = join(base, `${id}.json`);
    const item = JSON.parse(await readFile(filename, 'utf8')) as ChatAttachment;
    if (item.id !== id) throw new Error('Invalid attachment');
    // Upgrade existing selected-folder snapshots once, without requiring another upload.
    if (item.type === 'project' && item.projectFiles && !item.codeIndex) {
      item.codeIndex = buildCodeIndex(item.projectFiles);
      item.indexRevision = item.codeIndex.revision;
      const temporary = filename + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(item), {mode: 0o600});
      await rename(temporary, filename);
    }
    return item;
  }));
}
export async function attachmentImages(artifacts: string, files: ChatAttachment[]): Promise<string[]> {
  return Promise.all(files.filter(f=>f.type==='image').slice(0,4).map(async f=>`data:${f.mime};base64,${(await readFile(join(artifacts,f.filename!))).toString('base64')}`));
}
