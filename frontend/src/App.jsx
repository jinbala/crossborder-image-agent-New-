import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import UploadPage from './pages/UploadPage.jsx';
import ProductInfoPage from './pages/ProductInfoPage.jsx';
import PlatformRulesPage from './pages/PlatformRulesPage.jsx';
import ImagePlanPage from './pages/ImagePlanPage.jsx';
import GeneratePage from './pages/GeneratePage.jsx';
import ReviewPage from './pages/ReviewPage.jsx';
import ExportPage from './pages/ExportPage.jsx';
import BatchPage from './pages/BatchPage.jsx';
import WorkflowTemplatesPage from './pages/WorkflowTemplatesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SnapshotPage from './pages/SnapshotPage.jsx';
import HealthPage from './pages/HealthPage.jsx';
import StoragePage from './pages/StoragePage.jsx';
import CleanupPage from './pages/CleanupPage.jsx';
import StressTestPage from './pages/StressTestPage.jsx';
import MattingPage from './pages/MattingPage.jsx';
import FinalAcceptancePage from './pages/FinalAcceptancePage.jsx';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
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
        <Route path="/tasks/:taskId/product" element={<ProductInfoPage />} />
        <Route path="/tasks/:taskId/rules" element={<PlatformRulesPage />} />
        <Route path="/tasks/:taskId/plans" element={<ImagePlanPage />} />
        <Route path="/tasks/:taskId/generate" element={<GeneratePage />} />
        <Route path="/tasks/:taskId/review" element={<ReviewPage />} />
        <Route path="/tasks/:taskId/export" element={<ExportPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
