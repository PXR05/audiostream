import { writeFile, readFile } from "fs/promises";
import type { AudioModel } from "../modules/audio/model";

export abstract class MetadataCache {
  private static cache = new Map<string, AudioModel.audioMetadata>();
  private static isLoaded = false;
  private static isDirty = false;
  private static saveTimeout: Timer | null = null;
  private static readonly METADATA_FILE = "metadata.json";
  private static readonly SAVE_DELAY = 5000;

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

  private static scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      if (this.isDirty) {
        try {
          await this.save();
          this.isDirty = false;
        } catch (err) {
          console.error("[META_SAVE]:", err);
        }
      }
    }, this.SAVE_DELAY);
  }

  static set(filename: string, metadata: AudioModel.audioMetadata): void {
    this.cache.set(filename, metadata);
    this.isDirty = true;
    this.scheduleSave();
  }

  static delete(filename: string): void {
    this.cache.delete(filename);
    this.isDirty = true;
    this.scheduleSave();
  }

  static async flush(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (this.isDirty) {
      await this.save();
      this.isDirty = false;
    }
  }
}
