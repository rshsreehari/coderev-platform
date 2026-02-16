import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Home,
  History,
  AlertTriangle,
  Loader,
  TrendingUp,
  X,
  ChevronDown,
  ChevronUp,
  RotateCw,
  Download,
} from 'lucide-react';
import {
  submitReview,
  getJobStatus,
  getHistory,
  getDLQMessages,
  getDLQStats,
  retryDLQMessage,
  resolveDLQMessage,
  getHealth,
  getStats,
  downloadPDF,
} from './services/api';
import './index.css';


export default function CodeReviewPlatformWithDLQ() {
  const jobPollRef = useRef(null);
  // Tab and UI state
  const [activeTab, setActiveTab] = useState('submit');
  const [jobStatus, setJobStatus] = useState('idle');
  const [currentJobId, setCurrentJobId] = useState(null);
  const [jobResult, setJobResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  // DLQ state
  const [dlqMessages, setDlqMessages] = useState([]);
  const [dlqStats, setDlqStats] = useState(null);
  const [expandedDLQ, setExpandedDLQ] = useState(null);

  // History state
  const [historyItems, setHistoryItems] = useState([]);
  const [loading, setLoading] = useState(false);

  // System state
  const [systemStats, setSystemStats] = useState({
    cacheHitRate: '0%',
    queueDepth: 0,
    activeWorkers: 0,
    status: 'connecting',
  });

  // Polling interval
  const POLLING_INTERVAL = parseInt(import.meta.env.VITE_POLLING_INTERVAL) || 5000;

  // Fetch DLQ messages
  const fetchDLQMessages = async () => {
    try {
      const data = await getDLQMessages(false);
      setDlqMessages(data.messages || []);
    } catch (error) {
      console.error('Error fetching DLQ messages:', error);
    }
  };

  // Fetch DLQ stats
  const fetchDLQStats = async () => {
    try {
      const stats = await getDLQStats();
      setDlqStats(stats);
    } catch (error) {
      console.error('Error fetching DLQ stats:', error);
    }
  };

  // Fetch system health and stats
  const fetchSystemHealth = async () => {
    try {
      const healthData = await getHealth();
      const statsData = await getStats();

      setSystemStats({
        cacheHitRate: healthData.cacheHitRate || '0%',
        queueDepth: statsData.queueDepth || 0,
        activeWorkers: statsData.activeWorkers || 0,
        status: healthData.status || 'connected',
      });
    } catch (error) {
      console.error('Error fetching system health:', error);
      setSystemStats((prev) => ({
        ...prev,
        status: 'disconnected',
      }));
    }
  };

  // Fetch history
  const fetchHistory = async () => {
    try {
      setLoading(true);
      const data = await getHistory();
      // Backend returns array directly, not wrapped in object
      setHistoryItems(Array.isArray(data) ? data : data.jobs || []);
    } catch (error) {
      console.error('Error fetching history:', error);
      setStatusMessage('Failed to fetch history');
    } finally {
      setLoading(false);
    }
  };

  // Set up polling
  useEffect(() => {
    // Initial fetch
    fetchDLQMessages();
    fetchDLQStats();
    fetchSystemHealth();
    fetchHistory();

    // Set up intervals
    const dlqInterval = setInterval(fetchDLQMessages, POLLING_INTERVAL);
    const statsInterval = setInterval(fetchDLQStats, POLLING_INTERVAL);
    const healthInterval = setInterval(fetchSystemHealth, POLLING_INTERVAL);

    return () => {
      clearInterval(dlqInterval);
      clearInterval(statsInterval);
      clearInterval(healthInterval);
    };
  }, []);

  // Handle file upload
  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setJobStatus('uploading');
    setStatusMessage('Uploading file...');
    setUploadProgress(0);

    try {
      // Simulate upload progress
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => Math.min(prev + 10, 90));
      }, 100);

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const fileContent = e.target?.result;
          const response = await submitReview(file.name, fileContent);

          clearInterval(progressInterval);
          setUploadProgress(100);

          if (response.jobId) {
            setCurrentJobId(response.jobId);
            setJobStatus('processing');
            setStatusMessage('Processing your file...');

            // Start polling for job status
            pollJobStatus(response.jobId);
          }
        } catch (error) {
          clearInterval(progressInterval);
          setJobStatus('error');
          setStatusMessage(`Error: ${error.response?.data?.error || error.message}`);
        }
      };

      reader.readAsText(file);
    } catch (error) {
      setJobStatus('error');
      setStatusMessage(`Error: ${error.message}`);
    }
  };

  // Poll job status
  const pollJobStatus = async (jobId) => {
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds with 500ms intervals

    if (jobPollRef.current) clearInterval(jobPollRef.current);

    jobPollRef.current = setInterval(async () => {
      attempts++;

      try {
        const data = await getJobStatus(jobId);

        if (data.status === 'complete') {
          clearInterval(jobPollRef.current);
          jobPollRef.current = null;
          setJobStatus('complete');
          // Map backend result fields to frontend expectations
          const mappedResult = {
            ...data.result,
            securityIssues: data.result?.security || [],
            performanceIssues: data.result?.performance || [],
            cacheHit: data.cache_hit || false,
          };
          setJobResult(mappedResult);
          setStatusMessage('Review completed!');
          await fetchHistory();
        } else if (data.status === 'failed') {
          clearInterval(jobPollRef.current);
          jobPollRef.current = null;
          setJobStatus('error');
          setStatusMessage('Job failed - moved to DLQ');
          fetchDLQMessages();
        } else if (attempts >= maxAttempts) {
          clearInterval(jobPollRef.current);
          jobPollRef.current = null;
          setJobStatus('error');
          setStatusMessage('Processing timeout - check DLQ');
        } else if (data.status === 'dlq') {
          clearInterval(jobPollRef.current);
          jobPollRef.current = null;
          setJobStatus('dlq'); 
          setStatusMessage('Moved to DLQ');
          fetchDLQMessages();
        } else {
          setStatusMessage(`Processing... (attempt ${attempts}/${maxAttempts})`);
        }
      } catch (error) {
        clearInterval(jobPollRef.current);
        jobPollRef.current = null;
        setJobStatus('error');
        setStatusMessage(`Error: ${error.message}`);
      }
    }, 500);
  };

  // Handle retry DLQ message
  const handleRetryDLQ = async (dlqId) => {
    try {
      setStatusMessage('Retrying DLQ message...');
      await retryDLQMessage(dlqId);
      setStatusMessage('Message retried successfully');
      setTimeout(() => {
        fetchDLQMessages();
        fetchDLQStats();
      }, 1000);
    } catch (error) {
      setStatusMessage(`Retry failed: ${error.message}`);
    }
  };

  // Handle resolve DLQ message
  const handleResolveDLQ = async (dlqId, reason = 'Manual resolution') => {
    try {
      setStatusMessage('Resolving DLQ message...');
      await resolveDLQMessage(dlqId, reason);
      setStatusMessage('Message resolved');
      setTimeout(() => {
        fetchDLQMessages();
        fetchDLQStats();
      }, 1000);
    } catch (error) {
      setStatusMessage(`Resolution failed: ${error.message}`);
    }
  };

  // Reset upload form
  const resetUpload = () => {
    if (jobPollRef.current) {
        clearInterval(jobPollRef.current);
        jobPollRef.current = null;
    }
    setJobStatus('idle');
    setCurrentJobId(null);
    setJobResult(null);
    setUploadProgress(0);
    setStatusMessage('');
  };

  // DLQ badge count
  const dlqCount = dlqMessages.length || 0;

  return (
    <div className="min-h-screen bg-slate-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-gradient-to-r from-slate-900 to-slate-800 border-b border-slate-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Home className="w-8 h-8 text-blue-400" />
              <div>
                <h1 className="text-3xl font-bold text-white">Code Review Platform</h1>
                <p className="text-sm text-gray-400">With DLQ Management & Real-time Monitoring</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm text-gray-400">System Status</p>
                <p className="flex items-center gap-2">
                  <span
                    className={`inline-block w-3 h-3 rounded-full ${
                      systemStats.status === 'connected' ||
                      systemStats.status === 'ok'
                        ? 'bg-green-500'
                        : 'bg-red-500'
                    }`}
                  />
                  <span className="font-semibold capitalize">
                    {systemStats.status}
                  </span>
                </p>
              </div>
            </div>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
              <p className="text-xs text-gray-400">Cache Hit Rate</p>
              <p className="text-lg font-bold text-blue-400">{systemStats.cacheHitRate}</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
              <p className="text-xs text-gray-400">Queue Depth</p>
              <p className="text-lg font-bold text-green-400">{systemStats.queueDepth}</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
              <p className="text-xs text-gray-400">Active Workers</p>
              <p className="text-lg font-bold text-purple-400">{systemStats.activeWorkers}</p>
            </div>
            <div className="bg-red-900/20 rounded-lg p-3 border border-red-800/30">
              <p className="text-xs text-gray-400">Failed Jobs (DLQ)</p>
              <p className="text-lg font-bold text-red-400">{dlqCount}</p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-t border-slate-700 bg-slate-900/50">
          <div className="max-w-7xl mx-auto px-4 flex gap-0">
            {[
              { id: 'submit', label: 'Submit', icon: Upload },
              { id: 'results', label: 'Results', icon: CheckCircle },
              { id: 'history', label: 'History', icon: History },
              { id: 'dlq', label: 'DLQ Management', icon: AlertTriangle },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setActiveTab(id);
                  if (id === 'history') fetchHistory();
                }}
                className={`px-4 py-3 flex items-center gap-2 border-b-2 transition-all relative ${
                  activeTab === id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="font-medium">{label}</span>
                {id === 'dlq' && dlqCount > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-red-600 text-white text-xs font-bold rounded-full">
                    {dlqCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
        {/* Status Message */}
        {statusMessage && (
          <div
            className="mb-6 p-4 rounded-lg border flex items-start gap-3 animate-pulse"
            style={{
              backgroundColor:
                jobStatus === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)',
              borderColor:
                jobStatus === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)',
            }}
          >
            {jobStatus === 'error' ? (
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
            ) : jobStatus === 'complete' || jobStatus === 'success' ? (
            <CheckCircle className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
            ) : (
            <Loader className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0 animate-spin" />
            )}
            <p className="flex-1">{statusMessage}</p>
            <button
              onClick={() => setStatusMessage('')}
              className="text-gray-400 hover:text-gray-300"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Submit Tab */}
        {activeTab === 'submit' && (
          <div className="space-y-6">
            {jobStatus === 'idle' ? (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Upload Area */}
                <div className="lg:col-span-2">
                  <div className="bg-slate-900 rounded-lg border border-slate-700 p-8 text-center hover:border-slate-600 transition-colors">
                    <input
                      type="file"
                      accept=".js,.jsx,.ts,.tsx,.java,.py,.go,.cpp"
                      onChange={handleFileUpload}
                      className="hidden"
                      id="file-input"
                    />
                    <label
                      htmlFor="file-input"
                      className="cursor-pointer flex flex-col items-center gap-4"
                    >
                      <Upload className="w-12 h-12 text-blue-400" />
                      <div>
                        <p className="text-xl font-semibold text-white mb-2">
                          Upload code for review
                        </p>
                        <p className="text-sm text-gray-400 mb-2">
                          Supported formats: JS, TS, Java, Python, Go, C++
                        </p>
                        <p className="text-xs text-gray-500">
                          Click to browse or drag and drop
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {/* System Status Sidebar */}
                <div className="bg-slate-900 rounded-lg border border-slate-700 p-6 h-fit">
                  <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-purple-400" />
                    System Info
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-gray-400">Cache Performance</p>
                      <p className="text-sm font-semibold text-green-400">
                        {systemStats.cacheHitRate}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Pending Jobs</p>
                      <p className="text-sm font-semibold text-blue-400">
                        {systemStats.queueDepth}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Active Workers</p>
                      <p className="text-sm font-semibold text-orange-400">
                        {systemStats.activeWorkers}
                      </p>
                    </div>
                    <div className="pt-3 border-t border-slate-700">
                      <p className="text-xs text-gray-400 mb-2">Failed Jobs</p>
                      <p className="text-2xl font-bold text-red-400">{dlqCount}</p>
                      {dlqCount > 0 && (
                        <p className="text-xs text-red-400 mt-2">
                          Check DLQ tab to manage failures
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-900 rounded-lg border border-slate-700 p-8">
                <div className="flex items-center gap-4 mb-6">
                    {jobStatus === 'complete' ? (
                        <CheckCircle className="w-8 h-8 text-green-400" />
                    ) : jobStatus === 'error' ? (
                        <AlertTriangle className="w-8 h-8 text-red-400" />
                    ) : (
                        <Loader className="w-8 h-8 text-blue-400 animate-spin" />
                    )}

                    <div className="flex-1">
                        <p className="font-semibold text-white">
                        {jobStatus === 'uploading' && 'Uploading file...'}
                        {jobStatus === 'processing' && 'Processing your code...'}
                        {jobStatus === 'complete' && 'Review completed!'}
                        {jobStatus === 'error' && 'Job moved to DLQ / failed'}
                        </p>
                        <p className="text-sm text-gray-400 mt-1">
                        Job ID: {currentJobId}
                        </p>
                    </div>
                </div>


                {/* Progress Bar */}
                <div className="mb-6">
                  <div className="w-full bg-slate-800 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-blue-500 to-blue-400 h-2 rounded-full transition-all"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-2">{uploadProgress}% complete</p>
                </div>

                {jobStatus === 'complete' && jobResult && (
                  <div className="space-y-4">
                    <div className="bg-green-900/20 border border-green-800/30 rounded-lg p-4">
                      <p className="flex items-center gap-2 text-green-400 font-semibold">
                        <CheckCircle className="w-5 h-5" />
                        Review Completed Successfully
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-gray-400 mb-2">Security Issues</p>
                        <p className="text-2xl font-bold text-red-400">
                          {jobResult.securityIssues?.length || 0}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-400 mb-2">Performance Issues</p>
                        <p className="text-2xl font-bold text-yellow-400">
                          {jobResult.performanceIssues?.length || 0}
                        </p>
                      </div>
                    </div>

                    {jobResult.cacheHit && (
                      <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg p-3">
                        <p className="text-sm text-blue-400">
                          ✓ Cache Hit - Result served from cache
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={resetUpload}
                  className="mt-6 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                >
                  {jobStatus === 'complete' ? 'Submit Another' : 'Cancel'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Results Tab */}
        {activeTab === 'results' && (
          <div className="space-y-4">
            {jobResult ? (
              <div className="bg-slate-900 rounded-lg border border-slate-700 p-6 space-y-6">
                {/* Header with Download Button */}
                <div className="flex items-center justify-between pb-4 border-b border-slate-700">
                  <div>
                    <h2 className="text-xl font-bold text-white">Review Results</h2>
                    <p className="text-sm text-gray-400 mt-1">
                      Completed in {jobResult.metrics?.reviewTime || 'N/A'} • {jobResult.metrics?.linesAnalyzed || 0} lines analyzed
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {jobResult.cacheHit && (
                      <span className="px-3 py-1 bg-green-900/30 border border-green-800/50 rounded-full text-xs text-green-400 font-medium">
                        ⚡ Cache Hit
                      </span>
                    )}
                    <button
                      onClick={() => {
                        if (currentJobId) {
                          downloadPDF(currentJobId);
                        }
                      }}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center gap-2 text-sm font-medium transition duration-200 text-white"
                    >
                      <Download className="w-4 h-4" />
                      Download Report
                    </button>
                  </div>
                </div>

                {/* Summary */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                    <p className="text-sm text-gray-400">Security Issues</p>
                    <p className="text-3xl font-bold text-red-400">
                      {jobResult.securityIssues?.length || 0}
                    </p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                    <p className="text-sm text-gray-400">Performance Issues</p>
                    <p className="text-3xl font-bold text-yellow-400">
                      {jobResult.performanceIssues?.length || 0}
                    </p>
                  </div>
                  <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                    <p className="text-sm text-gray-400">Code Quality</p>
                    <p className="text-3xl font-bold text-green-400">
                      {jobResult.qualityScore || 'A'}
                    </p>
                  </div>
                </div>

                {/* Cache Hit Indicator */}
                {jobResult.cacheHit && (
                  <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg p-4 flex items-center gap-3">
                    <CheckCircle className="w-6 h-6 text-blue-400 flex-shrink-0" />
                    <div>
                      <p className="font-semibold text-blue-300">Cache Hit!</p>
                      <p className="text-sm text-blue-400">Result served from cache in &lt;100ms</p>
                    </div>
                  </div>
                )}

                {/* Security Issues */}
                {jobResult.securityIssues && jobResult.securityIssues.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                      <AlertCircle className="w-5 h-5 text-red-400" />
                      Security Issues ({jobResult.securityIssues.length})
                    </h3>
                    <div className="space-y-2">
                      {jobResult.securityIssues.map((issue, idx) => (
                        <div
                          key={idx}
                          className="bg-red-900/20 border border-red-800/30 rounded-lg p-4"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-red-300 font-semibold">{issue.rule || 'Security Issue'}</p>
                              <p className="text-sm text-red-400 mt-2">{issue.message}</p>
                              {issue.fix && (
                                <p className="text-xs text-red-300 mt-2">💡 Fix: {issue.fix}</p>
                              )}
                            </div>
                            <span className={`px-2 py-1 rounded text-xs font-semibold whitespace-nowrap ml-2 ${
                              issue.severity === 'critical' ? 'bg-red-700 text-red-100' :
                              issue.severity === 'high' ? 'bg-red-600 text-red-100' :
                              'bg-red-500 text-red-100'
                            }`}>
                              {issue.severity?.toUpperCase()}
                            </span>
                          </div>
                          {issue.line && <p className="text-xs text-gray-500 mt-3">📍 Line {issue.line}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Performance Issues */}
                {jobResult.performanceIssues && jobResult.performanceIssues.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-yellow-400" />
                      Performance Issues ({jobResult.performanceIssues.length})
                    </h3>
                    <div className="space-y-2">
                      {jobResult.performanceIssues.map((issue, idx) => (
                        <div
                          key={idx}
                          className="bg-yellow-900/20 border border-yellow-800/30 rounded-lg p-4"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-yellow-300 font-semibold">{issue.rule || 'Performance Issue'}</p>
                              <p className="text-sm text-yellow-400 mt-2">{issue.message}</p>
                              {issue.fix && (
                                <p className="text-xs text-yellow-300 mt-2">💡 Fix: {issue.fix}</p>
                              )}
                            </div>
                            <span className={`px-2 py-1 rounded text-xs font-semibold whitespace-nowrap ml-2 ${
                              issue.severity === 'critical' ? 'bg-yellow-700 text-yellow-100' :
                              'bg-yellow-600 text-yellow-100'
                            }`}>
                              {issue.severity?.toUpperCase()}
                            </span>
                          </div>
                          {issue.line && <p className="text-xs text-gray-500 mt-3">📍 Line {issue.line}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Suggestions */}
                {jobResult.aiSuggestions && jobResult.aiSuggestions.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                      <RefreshCw className="w-5 h-5 text-purple-400" />
                      🤖 AI Suggestions ({jobResult.aiSuggestions.length})
                    </h3>
                    <div className="space-y-2">
                      {jobResult.aiSuggestions.map((suggestion, idx) => (
                        <div
                          key={idx}
                          className="bg-purple-900/20 border border-purple-800/30 rounded-lg p-4"
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex-1">
                              <p className="text-purple-300 font-semibold">{suggestion.issue || 'AI Suggestion'}</p>
                              <p className="text-xs text-purple-400 mt-1">Category: {suggestion.category || 'general'}</p>
                            </div>
                            <span className={`px-2 py-1 rounded text-xs font-semibold whitespace-nowrap ml-2 ${
                              suggestion.severity === 'critical' ? 'bg-red-700 text-red-100' :
                              suggestion.severity === 'high' ? 'bg-orange-700 text-orange-100' :
                              suggestion.severity === 'medium' ? 'bg-yellow-700 text-yellow-100' :
                              'bg-blue-700 text-blue-100'
                            }`}>
                              {suggestion.severity?.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-sm text-purple-400 mt-2"><strong>Issue:</strong> {suggestion.explanation || suggestion.message}</p>
                          <p className="text-sm text-purple-300 mt-2"><strong>Fix:</strong> {suggestion.suggestion || 'See explanation'}</p>
                          {suggestion.line && <p className="text-xs text-gray-500 mt-3">📍 Line {suggestion.line}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Legacy AI Suggestions (for backward compatibility) */}
                {jobResult.aiSuggestions && jobResult.aiSuggestions.length === 0 && 
                 jobResult.type && jobResult.type === 'code-quality' && (
                  <div>
                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                      <RefreshCw className="w-5 h-5 text-blue-400" />
                      Code Quality Suggestions
                    </h3>
                    <div className="space-y-2">
                      {jobResult.map && jobResult.map((suggestion, idx) => (
                        <div
                          key={idx}
                          className="bg-blue-900/20 border border-blue-800/30 rounded-lg p-4"
                        >
                          <p className="text-blue-300 font-semibold">{suggestion.type || 'Suggestion'}</p>
                          <p className="text-sm text-blue-400 mt-2">{suggestion.message}</p>
                          {suggestion.severity && (
                            <span className={`inline-block mt-2 px-2 py-1 rounded text-xs font-semibold ${
                              suggestion.severity === 'critical' ? 'bg-red-700 text-red-100' :
                              suggestion.severity === 'warning' ? 'bg-yellow-700 text-yellow-100' :
                              'bg-blue-700 text-blue-100'
                            }`}>
                              {suggestion.severity?.toUpperCase()}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-slate-900 rounded-lg border border-slate-700 p-8 text-center">
                <AlertCircle className="w-12 h-12 text-gray-500 mx-auto mb-3" />
                <p className="text-gray-400">No review results yet. Submit a file to get started!</p>
              </div>
            )}
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            {loading ? (
              <div className="text-center py-12">
                <Loader className="w-8 h-8 text-blue-400 mx-auto animate-spin" />
              </div>
            ) : historyItems.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700">
                      <th className="text-left py-3 px-4 font-semibold text-gray-300">
                        File Name
                      </th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-300">
                        Status
                      </th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-300">
                        Issues
                      </th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-300">
                        Cache
                      </th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-300">
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyItems.map((item, idx) => (
                      <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                        <td className="py-3 px-4">{item.file_name}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-1 rounded text-xs font-semibold ${
                              item.status === 'complete'
                                ? 'bg-green-900/30 text-green-400'
                                : item.status === 'failed'
                                ? 'bg-red-900/30 text-red-400'
                                : item.status === 'dlq'
                                ? 'bg-orange-900/30 text-orange-400'
                                : 'bg-blue-900/30 text-blue-400'
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td className="py-3 px-4">{item.issues_found !== null ? item.issues_found : '-'}</td>
                        <td className="py-3 px-4">
                          {item.cache_hit ? (
                            <CheckCircle className="w-4 h-4 text-green-400" />
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-gray-500">
                          {new Date(item.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="bg-slate-900 rounded-lg border border-slate-700 p-8 text-center">
                <History className="w-12 h-12 text-gray-500 mx-auto mb-3" />
                <p className="text-gray-400">No history yet. Submit reviews to see them here!</p>
              </div>
            )}
          </div>
        )}

        {/* DLQ Tab */}
        {activeTab === 'dlq' && (
          <div className="space-y-6">
            {/* DLQ Stats */}
            {dlqStats && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-900 rounded-lg border border-slate-700 p-4">
                  <p className="text-sm text-gray-400">Total Failed</p>
                  <p className="text-3xl font-bold text-red-400">{dlqStats.total}</p>
                </div>
                <div className="bg-slate-900 rounded-lg border border-slate-700 p-4">
                  <p className="text-sm text-gray-400">Unresolved</p>
                  <p className="text-3xl font-bold text-orange-400">
                    {dlqStats.unresolved}
                  </p>
                </div>
                <div className="bg-slate-900 rounded-lg border border-slate-700 p-4">
                  <p className="text-sm text-gray-400">Resolved</p>
                  <p className="text-3xl font-bold text-green-400">{dlqStats.resolved}</p>
                </div>
                <div className="bg-slate-900 rounded-lg border border-slate-700 p-4">
                  <p className="text-sm text-gray-400">Avg Retries</p>
                  <p className="text-3xl font-bold text-blue-400">
                    {dlqStats.averageRetries?.toFixed(1) || 0}
                  </p>
                </div>
              </div>
            )}

            {/* DLQ Messages List */}
            {dlqMessages.length > 0 ? (
              <div className="space-y-3">
                {dlqMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className="bg-slate-900 rounded-lg border border-red-800/30 overflow-hidden hover:border-red-700/50 transition-colors"
                  >
                    {/* Message Header */}
                    <div
                      className="p-4 bg-red-900/20 cursor-pointer hover:bg-red-900/30 transition-colors"
                      onClick={() =>
                        setExpandedDLQ(expandedDLQ === msg.id ? null : msg.id)
                      }
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
                            <div>
                              <p className="font-semibold text-white">
                                {msg.file_name || `Job ${msg.job_id}`}
                              </p>
                              <p className="text-sm text-gray-400">
                                Failed on{' '}
                                {new Date(msg.moved_to_dlq_at).toLocaleDateString()}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="px-2 py-1 bg-red-900/50 text-red-300 text-xs font-semibold rounded">
                            Retries: {msg.retry_count || 0}
                          </span>
                          {expandedDLQ === msg.id ? (
                            <ChevronUp className="w-5 h-5 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-gray-400" />
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Expanded Details */}
                    {expandedDLQ === msg.id && (
                      <div className="p-4 border-t border-slate-700 space-y-4">
                        <div>
                          <p className="text-xs text-gray-400 mb-1">Error Message</p>
                          <div className="bg-slate-800/50 rounded p-3 border border-slate-700">
                            <p className="text-sm text-red-300 font-mono break-words">
                              {msg.last_error || 'No error message'}
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs text-gray-400 mb-1">Job ID</p>
                            <p className="text-sm font-mono text-blue-400">
                              {msg.job_id}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-gray-400 mb-1">Message ID</p>
                            <p className="text-sm font-mono text-gray-300">
                              {msg.message_id?.substring(0, 20)}...
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-gray-400 mb-1">
                              Receive Count
                            </p>
                            <p className="text-sm text-gray-300">
                              {msg.receive_count || 0}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-gray-400 mb-1">
                              Last Retry
                            </p>
                            <p className="text-sm text-gray-300">
                              {msg.last_retry_at
                                ? new Date(
                                    msg.last_retry_at
                                  ).toLocaleDateString()
                                : 'Never'}
                            </p>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 pt-4 border-t border-slate-700">
                          <button
                            onClick={() => handleRetryDLQ(msg.id)}
                            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                          >
                            <RotateCw className="w-4 h-4" />
                            Retry
                          </button>
                          <button
                            onClick={() =>
                              handleResolveDLQ(msg.id, 'Manual resolution')
                            }
                            className="flex-1 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                          >
                            <X className="w-4 h-4" />
                            Resolve
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-slate-900 rounded-lg border border-slate-700 p-12 text-center">
                <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
                <p className="text-gray-300 text-lg font-semibold">
                  No failed jobs!
                </p>
                <p className="text-gray-400 text-sm mt-2">
                  All jobs are processing successfully.
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-slate-900 border-t border-slate-700 mt-12">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <h3 className="font-semibold text-white mb-2">System Architecture</h3>
              <ul className="text-sm text-gray-400 space-y-1">
                <li>✓ Express.js API Server</li>
                <li>✓ Worker Queue (SQS)</li>
                <li>✓ DLQ Management</li>
                <li>✓ Redis Caching</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-2">Features</h3>
              <ul className="text-sm text-gray-400 space-y-1">
                <li>✓ Real-time Code Analysis</li>
                <li>✓ Failed Job Recovery</li>
                <li>✓ Cache Hit Optimization</li>
                <li>✓ Live DLQ Monitoring</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-2">API Endpoints</h3>
              <ul className="text-sm text-gray-400 space-y-1">
                <li>/api/reviews/submit</li>
                <li>/api/reviews/status/:jobId</li>
                <li>/api/dlq</li>
                <li>/health</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-700 mt-6 pt-6 text-center text-sm text-gray-500">
            <p>
              © 2024 Code Review Platform | DLQ Implementation v1.0.0
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
