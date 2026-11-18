import type { CmsListPointer, CmsPage } from './index';

export type CmsPageField = Exclude<keyof CmsPage, 'tags' | 'isPublished'>;

export interface CmsListOptions {
  parentId?: number;
  pointer?: CmsListPointer;
  q?: string;
  limit?: number;
  offset?: number;
  field?: { key: string; values: readonly string[] };
  range?: { key: string; from?: string | number; to?: string | number };
  ids?: readonly number[];
  slugs?: readonly string[];
  fields?: readonly CmsPageField[];
  includeTags?: boolean;
  includeLiveStatus?: boolean;
  /** Set false to skip counting. The host returns total: -1. */
  count?: boolean;
}

export interface CmsPageListResult<TPage = CmsPage> {
  pages: TPage[];
  total: number;
  limit: number;
  offset: number;
}

/** List/search tag metadata. A single-page get still returns tag IDs. */
export interface CmsPageTag {
  id: number;
  name: string;
  taxonomy: string;
  taxonomy_slug: string;
}

export type CmsPageWithTags = Omit<CmsPage, 'tags'> & { tags: CmsPageTag[] };

export interface CmsSearchCriterion {
  term?: string;
  search?: string;
  path?: string;
  tags?: readonly (number | string)[] | string;
  index?: number;
}

export interface CmsSearchQuery {
  page_type?: string;
  page_types?: readonly string[] | string;
  criteria: readonly CmsSearchCriterion[];
  operator?: 'AND' | 'OR' | 'NOT' | 'and' | 'or' | 'not';
  limit?: number;
  pagesize?: number;
  page?: number;
  sort?: 'id' | 'name' | 'slug' | 'weight' | 'created_at' | 'updated_at';
  order?: 'asc' | 'desc' | 'ASC' | 'DESC';
  include_tags?: boolean;
}

export interface CmsSearchResult extends CmsPageListResult<Omit<CmsPage, 'tags'> & { tags?: CmsPageTag[] }> {
  pagination: { total: number; totalPages: number; currentPage: number; limit: number };
  page_types: string[];
}

export interface CmsBatchError {
  index: number;
  error: string;
}

export interface CmsBatchUpdateInput {
  id: number;
  lect: Record<string, unknown>;
  version_action?: string;
}

export interface CmsBatchUpdateResult {
  updated: CmsPage[];
  errors: CmsBatchError[];
  count: number;
}

export interface CmsDuplicatePagesInput {
  source_page_type: string;
  source_page_id?: number;
  source_pointer_key?: string;
  source_pointer_value?: string;
  target_page_id?: number | null;
  lect?: Record<string, unknown>;
  drop_lect?: readonly string[];
  cursor?: number | null;
}

export interface CmsDuplicatePagesResult {
  count: number;
  next_cursor: number | null;
  done: boolean;
}

export interface CmsDeleteChildPagesInput {
  page_type: string;
  parent_page_id?: number;
  pointer_key?: string;
  pointer_value?: string;
}

export interface CmsDeleteChildPagesResult {
  trashed: number;
  done: boolean;
}

export interface CmsPublishError extends CmsBatchError {
  id?: number;
  page_type?: string;
  failed_targets?: string[];
}

export interface CmsPublishPagesResult {
  published: number[];
  errors: CmsPublishError[];
  count: number;
}

export interface CmsContentMeta {
  page_types: string[];
  languages: string[];
  default_language: string;
  taxonomies: Array<{ name: string; slug: string }>;
  path_specs: Record<string, Array<{ path: string; kind: 'scalar' | 'localized' | 'pointer' }>>;
}

export interface CmsEnsureTagInput {
  taxonomy: string;
  name: string;
}

export interface CmsEnsureTagsResult {
  tags: Array<CmsEnsureTagInput & { id: number }>;
  errors: CmsBatchError[];
}

export interface CmsLimit {
  key: string;
  label: string;
  description: string;
  page_type: string | null;
  scope: 'total' | 'per_parent' | 'per_pointer' | 'per_second';
  pointer_key: string | null;
  value: number | null;
  configured: boolean;
  usage: number | null;
}

export interface CmsIngestSubmissionsResult {
  ok: true;
  scanned: number;
  created: number;
  more: boolean;
}

export interface CmsSequence {
  key: string;
  value: number;
}

export interface CmsFileListOptions {
  prefix?: string;
  delimiter?: '/';
  limit?: number;
  cursor?: string;
}

export interface CmsFileListEntry {
  key: string;
  size: number;
  etag: string;
  http_etag: string;
  uploaded: string;
  content_type: string;
}

export interface CmsFileListResult {
  objects: CmsFileListEntry[];
  delimited_prefixes: string[];
  truncated: boolean;
  cursor?: string;
}

export interface CmsFileUploadResult {
  ok: true;
  key: string;
  size: number;
}
