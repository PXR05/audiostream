import { writeFile, readFile } from "fs/promises";
import type { AudioModel } from "../modules/audio/model";

export abstract class MetadataCache {
  private static cache = new Map<string, AudioModel.audioMetadata>();
  private static isLoaded = false;
  private static readonly METADATA_FILE = "metadata.json";

  static async load(): Promise<void> {
    if (this.isLoaded) return;

    try {
      const data = await readFile(this.METADATA_FILE, "utf-8");
      const stored = JSON.parse(data);
      this.cache = new Map(Object.entries(stored));
    } catch {}
    this.isLoaded = true;
  }

  static async save(): Promise<void> {
    const data = JSON.stringify(Object.fromEntries(this.cache));
    await writeFile(this.METADATA_FILE, data);
  }

  static get(filename: string): AudioModel.audioMetadata | undefined {
    return this.cache.get(filename);
  }

  static set(filename: string, metadata: AudioModel.audioMetadata): void {
    this.cache.set(filename, metadata);
    this.save().catch((err) => console.error("[META_SET]:", err));
  }

  static delete(filename: string): void {
    this.cache.delete(filename);
    this.save().catch((err) => console.error("[META_DEL]:", err));
  }
}
