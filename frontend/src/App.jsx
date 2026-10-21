import { useLocale } from './i18n/LocaleProvider.jsx';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import Layout from './components/Layout.jsx';
import { useAccount } from './components/AuthGate.jsx';
const SupportPage = lazy(() => import('./pages/SupportPage.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const UploadPage = lazy(() => import('./pages/UploadPage.jsx'));
const ProductInfoPage = lazy(() => import('./pages/ProductInfoPage.jsx'));
const PlatformRulesPage = lazy(() => import('./pages/PlatformRulesPage.jsx'));
const ImagePlanPage = lazy(() => import('./pages/ImagePlanPage.jsx'));
const GeneratePage = lazy(() => import('./pages/GeneratePage.jsx'));
const ReviewPage = lazy(() => import('./pages/ReviewPage.jsx'));
const ExportPage = lazy(() => import('./pages/ExportPage.jsx'));
const WorkflowTemplatesPage = lazy(() => import('./pages/WorkflowTemplatesPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const SnapshotPage = lazy(() => import('./pages/SnapshotPage.jsx'));
const HealthPage = lazy(() => import('./pages/HealthPage.jsx'));
const StoragePage = lazy(() => import('./pages/StoragePage.jsx'));
const CleanupPage = lazy(() => import('./pages/CleanupPage.jsx'));
const StressTestPage = lazy(() => import('./pages/StressTestPage.jsx'));
const FinalAcceptancePage = lazy(() => import('./pages/FinalAcceptancePage.jsx'));
import DesktopPage from './pages/DesktopPage.jsx';
import SyncPage from './pages/SyncPage.jsx';
import ConnectionsPage from './pages/ConnectionsPage.jsx';
import WorkspaceHomePage from './pages/WorkspaceHomePage.jsx';
import { TaskCenterPage, ProductsPage, PersonalSpacePage, AccountPage, AnnouncementsPage } from './pages/WorkspacePages.jsx';
const BatchPage = lazy(() => import('./pages/BatchPage.jsx'));
const MattingPage = lazy(() => import('./pages/MattingPage.jsx'));
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage.jsx'));
const CommerceWorkbenchPage = lazy(() => import('./pages/CommerceWorkbenchPage.jsx'));
const MaterialsWorkbenchPage = lazy(() => import('./pages/MaterialsWorkbenchPage.jsx'));
const SkuPackPage = lazy(() => import('./pages/SkuPackPage.jsx'));
const CollectionWorkbenchPage = lazy(() => import('./pages/CollectionWorkbenchPage.jsx'));
const StudioPage = lazy(() => import('./pages/StudioPage.jsx'));
const JobResultPage = lazy(() => import('./pages/JobResultPage.jsx'));
const CommerceSandboxPage = lazy(() => import('./pages/CommerceSandboxPage.jsx'));

export default function App() {
  const { t } = useLocale();
  const support = useAccount()?.user?.role === 'support';
  const location = useLocation();
  if (support && !['/', '/support', '/account', '/announcements'].includes(location.pathname)) return <Layout><Navigate to="/support" replace /></Layout>;
  return (
    <Layout>
      <Suspense fallback={<p className="p-5 text-sm text-slate-500">{t("正在加载功能页面…")}</p>}>
      <Routes>
        <Route path="/" element={support ? <SupportPage /> : <WorkspaceHomePage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/legacy-dashboard" element={<Dashboard />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/batches" element={<BatchPage />} />
        <Route path="/batches/:batchId" element={<BatchPage />} />
        <Route path="/workflow-templates" element={<WorkflowTemplatesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/snapshots" element={<SnapshotPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/cleanup" element={<CleanupPage />} />
        <Route path="/stress-test" element={<StressTestPage />} />
        <Route path="/matting" element={<MattingPage />} />
        <Route path="/final-acceptance" element={<FinalAcceptancePage />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/desktop" element={<DesktopPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/pod" element={<StudioPage />} />
        <Route path="/scene" element={<StudioPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/task-center" element={<TaskCenterPage />} />
        <Route path="/results/:id" element={<JobResultPage />} />
        <Route path="/commerce-sandbox/:id" element={<CommerceSandboxPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/userSpace" element={<PersonalSpacePage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/announcements" element={<AnnouncementsPage />} />
        <Route path="/workbench/commerce" element={<CommerceWorkbenchPage />} />
        <Route path="/workbench/materials" element={<MaterialsWorkbenchPage />} />
        <Route path="/workbench/sku-pack" element={<SkuPackPage />} />
        <Route path="/workbench/collection" element={<CollectionWorkbenchPage />} />
        <Route path="/tasks/:taskId/product" element={<ProductInfoPage />} />
        <Route path="/tasks/:taskId/rules" element={<PlatformRulesPage />} />
        <Route path="/tasks/:taskId/plans" element={<ImagePlanPage />} />
        <Route path="/tasks/:taskId/generate" element={<GeneratePage />} />
        <Route path="/tasks/:taskId/review" element={<ReviewPage />} />
        <Route path="/tasks/:taskId/export" element={<ExportPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Layout>
  );
}
