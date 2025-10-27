export type ComponentType = "client" | "server" | "universal";

export type FileNode = {
  filePath: string;
  isClient: boolean;
  imports: string[];
  type?: ComponentType;
};

export type ComponentEnvGraphOptions = {
  tsConfigFilePath?: string;
  exclude?: string[];
};
