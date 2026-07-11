export type CatalogTemplateType = 'worker' | 'pages' | 'hybrid';
export type CatalogBindingType = 'kv' | 'd1' | 'r2' | 'ai' | 'var';

export interface CatalogTemplate {
  id: string;
  name: string;
  description?: string;
  author?: { name: string; url?: string };
  version: string;
  tags?: string[];
  icon?: string;
  homepage?: string;
  readmeUrl?: string;
  type: CatalogTemplateType;
  source?: { kind: string; url: string; [k: string]: any };
  sources?: { worker?: any; pages?: any };
  bindings?: { type: CatalogBindingType; name: string; title?: string; [k: string]: any }[];
  env?: Record<string, string>;
  routes?: string[];
  [key: string]: any;
}

export interface TemplateItem {
  template: CatalogTemplate;
  sourceId: number;
  sourceName: string;
  sourceCount: number;
}
