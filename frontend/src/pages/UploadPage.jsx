import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, X } from 'lucide-react';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';

const MAX_IMAGES = 15;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function validateFiles(files, existingFiles = []) {
  const nextFiles = Array.from(files || []);
  if (!nextFiles.length) return '';

  if (existingFiles.length + nextFiles.length > MAX_IMAGES) {
    return `最多只能上传 ${MAX_IMAGES} 张商品图片`;
  }

  const unsupported = nextFiles.find((file) => !SUPPORTED_TYPES.includes(file.type));
  if (unsupported) {
    return `不支持的图片格式：${unsupported.name}。仅支持 jpg、jpeg、png、webp。`;
  }

  const oversized = nextFiles.find((file) => file.size > MAX_FILE_SIZE);
  if (oversized) {
    return `单张图片不能超过 10MB：${oversized.name}`;
  }

  const total = [...existingFiles, ...nextFiles].reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_SIZE) {
    return '图片总大小不能超过 100MB。';
  }

  return '';
}

export default function UploadPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const nextPreviews = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(nextPreviews);

    return () => {
      nextPreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [files]);

  function addFiles(fileList) {
    const message = validateFiles(fileList, files);
    if (message) {
      setError(message);
      return;
    }

    setError('');
    setFiles((current) => [...current, ...Array.from(fileList || [])]);
  }

  function removeFile(index) {
    setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function submit(event) {
    event.preventDefault();
    if (!files.length) return;

    setBusy(true);
    setError('');
    try {
      const uploaded = await api.uploadImages(files);
      await api.recognize(uploaded.task.id);
      navigate(`/tasks/${uploaded.task.id}/product`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{t("上传商品图片")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("可一次上传主图、参数图、尺寸图、包装图、配件图和卖点图，最多") + " "}{MAX_IMAGES}{" " + t("张。")}</p>
      </div>
      <ErrorMessage error={error} />
      <Section title={t("商品原图")}>
        <form onSubmit={submit} className="space-y-5">
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`focus-within:ring-mint flex min-h-48 cursor-pointer flex-col items-center justify-center rounded border border-dashed px-5 py-8 text-center focus-within:ring-2 ${dragging ? 'border-mint bg-teal-50' : 'border-slate-300 bg-slate-50'}`}
          >
            <UploadCloud className="mb-3 text-mint" size={32} />
            <span className="font-medium text-ink">{t("选择商品图片或拖拽到这里")}</span>
            <span className="mt-1 text-sm text-slate-500">{t("支持 jpg、jpeg、png、webp；单张不超过 10MB，总量不超过 100MB。")}</span>
            <span className="mt-2 text-sm font-semibold text-mint">{t("已选择") + " "}{files.length} / {MAX_IMAGES}{" " + t("张图片")}</span>
            <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => addFiles(event.target.files)} />
          </label>

          {previews.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {previews.map((preview, index) => (
                <div key={`${preview.file.name}-${index}`} className="rounded border border-slate-200 bg-white p-3">
                  <div className="relative">
                    <img src={preview.url} alt={t("商品图 {value0}", { value0: (index + 1) })} className="aspect-square w-full rounded object-contain" />
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="focus-ring absolute right-2 top-2 grid h-8 w-8 place-items-center rounded bg-white text-slate-600 shadow hover:text-red-600"
                      aria-label={t("删除图片")}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className="mt-2 truncate text-xs font-medium text-slate-600">{index + 1}. {preview.file.name}</div>
                </div>
              ))}
            </div>
          )}

          <PrimaryButton busy={busy} disabled={!files.length}>{t("上传并识别全部图片")}</PrimaryButton>
        </form>
      </Section>
    </div>
  );
}
