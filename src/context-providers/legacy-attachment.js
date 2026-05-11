export function fileContentToFragments({ fileContent, retrievedAt }) {
  if (!fileContent) return [];
  return [{
    source_type: 'attachment',
    trusted: 'semi',
    origin: 'legacy:fileContent',
    content: fileContent,
    retrieved_at: retrievedAt,
  }];
}

export const legacyAttachmentProvider = {
  name: 'legacy-attachment',
  async prefetch(ctx) {
    return fileContentToFragments(ctx);
  },
};
