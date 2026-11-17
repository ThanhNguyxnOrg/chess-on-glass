export type ProviderName = "openai" | "anthropic";

export type ProviderSettings = {
  provider: ProviderName;
  model: string;
  cloudEnabled: boolean;
};
