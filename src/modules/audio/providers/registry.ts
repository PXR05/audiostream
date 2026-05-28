import { BaseAudioProvider } from "./base";
import { YoutubeProvider } from "./youtube";
import { TidalProvider } from "./tidal";

export class ProviderRegistry {
  private static providers = new Map<string, BaseAudioProvider>();

  static register(provider: BaseAudioProvider) {
    this.providers.set(provider.name, provider);
  }

  static get(name: string): BaseAudioProvider | undefined {
    return this.providers.get(name);
  }

  static getAll(): BaseAudioProvider[] {
    return Array.from(this.providers.values());
  }
}

ProviderRegistry.register(new YoutubeProvider());
ProviderRegistry.register(new TidalProvider());
