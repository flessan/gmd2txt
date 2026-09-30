import { detectFile } from "./file-detector.js";

export class ImportSession {
  constructor(items, ignored = []) { this.items = items; this.ignored = ignored; this.supportedFiles = items.flatMap(item => item.files); }

  static async inspect(files) {
    const list = Array.from(files || []);
    const detected = await Promise.all(list.map(async file => ({ file, detection: await detectFile(file) })));
    const supported = detected.filter(entry => entry.detection.kind !== "unknown");
    const ignored = detected.filter(entry => entry.detection.kind === "unknown").map(entry=>({file:entry.file,detection:entry.detection}));
    const groups = new Map();
    for (const entry of supported) {
      const stem = entry.file.name.replace(/\.[^.]+$/, "").toLowerCase();
      // Multiple level files remain separate items; future asset handlers can group by stem here.
      const relative=String(entry.file.webkitRelativePath||"").replace(/\\/g,"/"),directory=relative.includes("/")?relative.slice(0,relative.lastIndexOf("/")).toLowerCase():"root";
      const key = entry.detection.kind === "save" ? `save:${directory}`
        : entry.detection.kind === "texture" ? (entry.detection.assetType === "zip" ? `texture:zip:${directory}:${stem}` : `texture:loose-files:${directory}`)
          : entry.detection.kind === "audio" ? `audio:${directory}:${entry.file.name.toLowerCase()}`
            : entry.detection.kind === "project-backup" ? `project-backup:${directory}:${stem}`
              : `${entry.detection.kind}:${directory}:${stem}`;
      if (!groups.has(key)) groups.set(key, { key, kind: entry.detection.kind, files: [], detections: [] });
      groups.get(key).files.push(entry.file);
      groups.get(key).detections.push(entry.detection);
    }
    return new ImportSession([...groups.values()], ignored);
  }
}
