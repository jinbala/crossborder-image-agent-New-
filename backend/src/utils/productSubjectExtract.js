import { SharpMattingProvider } from '../providers/matting/sharpMattingProvider.js';

export async function extractProductSubject({ productReference, taskId = 'subject' }) {
  const provider = new SharpMattingProvider();
  const result = await provider.extractSubject({
    task: { id: taskId },
    sourceImage: {
      id: productReference?.sourceImageId,
      displayName: productReference?.displayName,
      filePath: productReference?.filePath
    }
  });
  return {
    status: result.status,
    subjectPngPath: result.output?.subjectPngPath || null,
    previewUrl: result.output?.previewUrl || '',
    maskPath: result.output?.maskPath || null,
    boundingBox: result.output?.boundingBox || null,
    method: result.method,
    error: result.error,
    metadata: {
      originalSize: result.metadata?.originalSize || 0,
      outputSize: result.metadata?.outputSize || 0,
      hasAlpha: Boolean(result.output?.hasAlpha),
      confidence: result.metadata?.confidence || 0
    }
  };
}
