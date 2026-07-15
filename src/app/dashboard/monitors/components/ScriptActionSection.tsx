import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-hot-toast";

interface ScriptActionConfig {
  id: string;
  enabled: boolean;
  script: string;
  triggerCondition: "down" | "up" | "both";
  timeout: number;
}

interface ScriptExecution {
  id: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
  triggerSource: "real" | "simulate";
  currentStatus: number;
  prevStatus: number | null;
  errorMessage: string | null;
  createdAt: string;
}

interface ScriptActionSectionProps {
  monitorId: string;
}

export function ScriptActionSection({ monitorId }: ScriptActionSectionProps) {
  const [script, setScript] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [triggerCondition, setTriggerCondition] =
    useState<ScriptActionConfig["triggerCondition"]>("both");
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  // 执行历史
  const [executions, setExecutions] = useState<ScriptExecution[]>([]);
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(
    null
  );

  // 模拟运行最近结果
  const [lastTestResult, setLastTestResult] = useState<ScriptExecution | null>(
    null
  );

  // AI 帮助弹窗
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [userRequirement, setUserRequirement] = useState("");

  // 加载配置
  const loadConfig = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/monitors/${monitorId}/script-action`);
      if (response.ok) {
        const data = await response.json();
        setScript(data.script || "");
        setEnabled(!!data.enabled);
        setTriggerCondition(data.triggerCondition || "both");
        setTimeoutSec(data.timeout || 30);
      }
    } catch (error) {
      console.error("加载脚本动作配置失败:", error);
      toast.error("加载脚本动作配置失败");
    } finally {
      setIsLoading(false);
    }
  };

  // 加载执行历史
  const loadHistory = async () => {
    try {
      const response = await fetch(
        `/api/monitors/${monitorId}/script-action/history`
      );
      if (response.ok) {
        const data = await response.json();
        setExecutions(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error("加载脚本执行历史失败:", error);
    }
  };

  useEffect(() => {
    loadConfig();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorId]);

  // 保存配置
  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`/api/monitors/${monitorId}/script-action`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          enabled,
          script,
          triggerCondition,
          timeout: timeoutSec,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "保存失败");
      }

      toast.success("脚本动作配置已保存");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "保存脚本动作配置失败"
      );
    } finally {
      setIsSaving(false);
    }
  };

  // 模拟运行
  const handleTest = async (simulatedStatus: number) => {
    setIsTesting(true);
    setLastTestResult(null);
    try {
      const response = await fetch(
        `/api/monitors/${monitorId}/script-action/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            simulatedStatus,
            script,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "模拟运行失败");
      }

      const data = await response.json();
      setLastTestResult(data.result);
      toast.success("模拟运行完成");
      // 刷新历史
      loadHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模拟运行失败");
    } finally {
      setIsTesting(false);
    }
  };

  // 状态文本
  const getStatusText = (status: number) => (status === 1 ? "正常" : "故障");

  // 格式化耗时
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // 构建完整提示词
  const buildPrompt = () => {
    return `我使用的是 coolmonitor（一个开源的 Node.js 网站监控系统，https://github.com/star7th/coolmonitor）。它在监控项状态变化（UP↔DOWN）时可以自动执行我配置的 Node.js 脚本。

请帮我写一个脚本，实现以下需求：
${userRequirement.trim() || "<请在这里描述你的需求，例如：当监控状态变为 DOWN 时，调用 Cloudflare API 将 DNS 记录切换到备用服务器>"}

脚本规范：
1. 必须导出一个 async 函数：module.exports = async (ctx) => { ... }
2. coolmonitor 调用时传入上下文对象 ctx，包含以下字段：
   - monitorId      监控项 ID（字符串）
   - monitorName    监控项名称（字符串）
   - monitorType    监控项类型（http/port/mysql/redis/icmp/push 等）
   - url            监控地址（如有，字符串）
   - hostname       主机名（如有，字符串）
   - port           端口号（如有，数字）
   - status         当前状态："UP"（正常）或 "DOWN"（故障）
   - statusCode     当前状态码：1=正常，0=异常
   - prevStatus     上一次状态："UP" / "DOWN" / null
   - prevStatusCode 上一次状态码
   - message        状态描述信息（字符串）
   - timestamp      触发时间（ISO 8601 字符串）
3. 脚本在独立的子进程中执行，默认超时 30 秒，超时后会被强制终止
4. 脚本异常或超时不会影响 coolmonitor 主进程的稳定性
5. 安全限制：只能使用以下 Node.js 内置模块：http、https、dns、crypto、url、querystring、zlib、path、os、util、events、stream、buffer、timers
6. 禁止使用 child_process（执行系统命令）、fs（文件读写）等模块，禁止使用第三方 npm 包
7. 用 console.log / console.error 输出的内容会被记录到执行历史中，方便排查

请直接给出完整的、可直接使用的脚本代码，并在关键步骤添加注释。`;
  };

  // 复制提示词
  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt());
      toast.success("提示词已复制到剪贴板，粘贴给 AI 即可");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  };

  if (isLoading) {
    return (
      <div className="dark:bg-dark-card bg-light-card rounded-lg border border-primary/15 hover:border-primary/30 transition-all p-6">
        <div className="flex items-center text-foreground/60">
          <i className="fas fa-spinner fa-spin mr-2"></i>
          加载脚本动作配置...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 脚本动作配置 */}
      <div className="dark:bg-dark-card bg-light-card rounded-lg border border-primary/15 hover:border-primary/30 transition-all p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <i className="fas fa-code text-primary"></i>
            <h3 className="text-lg font-medium">自定义脚本动作</h3>
          </div>
          {/* 启用开关 */}
          <label className="flex items-center cursor-pointer space-x-2">
            <span className="text-sm text-foreground/70">
              {enabled ? "已启用" : "已禁用"}
            </span>
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <div
                className={`w-11 h-6 rounded-full transition-colors ${
                  enabled ? "bg-primary" : "bg-foreground/30"
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform mt-0.5 ${
                    enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                ></div>
              </div>
            </div>
          </label>
        </div>

        {/* 触发条件与超时 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="space-y-2">
            <label className="block text-foreground/80 font-medium">
              触发条件
            </label>
            <select
              value={triggerCondition}
              onChange={(e) =>
                setTriggerCondition(
                  e.target.value as ScriptActionConfig["triggerCondition"]
                )
              }
              className="w-full px-4 py-2 rounded-lg dark:bg-dark-input bg-light-input border border-primary/20 focus:border-primary focus:outline-none"
            >
              <option value="both">状态变化时触发（UP 和 DOWN）</option>
              <option value="down">仅在 DOWN 时触发</option>
              <option value="up">仅在 UP 时触发</option>
            </select>
            <p className="text-xs text-foreground/50">
              选择脚本在什么状态下自动执行
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-foreground/80 font-medium">
              执行超时（秒）
            </label>
            <input
              type="number"
              value={timeoutSec}
              onChange={(e) =>
                setTimeoutSec(parseInt(e.target.value) || 30)
              }
              className="w-full px-4 py-2 rounded-lg dark:bg-dark-input bg-light-input border border-primary/20 focus:border-primary focus:outline-none"
              min="1"
              max="600"
            />
            <p className="text-xs text-foreground/50">
              超时后脚本将被强制终止（1-600 秒）
            </p>
          </div>
        </div>

        {/* 脚本编辑器 */}
        <div className="space-y-2 mb-6">
          <div className="flex items-center justify-between">
            <label className="block text-foreground/80 font-medium">
              Node.js 脚本
            </label>
            <button
              type="button"
              onClick={() => setShowHelpModal(true)}
              className="text-xs text-primary hover:underline flex items-center"
            >
              <i className="fas fa-magic-wand-sparkles mr-1"></i>
              如何让 AI 帮我写脚本
            </button>
          </div>
          <textarea
            value={script}
            onChange={(e) => {
              const val = e.target.value;
              setScript(val);
              // 用户编辑了脚本内容且开关未开启时，自动开启，避免忘记启用
              if (val.trim() && !enabled) {
                setEnabled(true);
              }
            }}
            className="w-full px-4 py-2 rounded-lg dark:bg-dark-input bg-light-input border border-primary/20 focus:border-primary focus:outline-none h-72 font-mono text-sm"
            spellCheck={false}
            placeholder="module.exports = async (ctx) => { ... }"
          />
          <p className="text-xs text-foreground/50">
            脚本在独立子进程中执行，导出一个 async 函数，参数 ctx 包含监控上下文信息。
            脚本异常或超时不会影响 coolmonitor 主进程。
          </p>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="bg-gradient-to-r from-primary to-secondary text-white px-6 py-2 rounded-button hover:opacity-90 transition-all flex items-center disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <i className="fas fa-circle-notch fa-spin mr-2"></i>保存中...
              </>
            ) : (
              <>
                <i className="fas fa-save mr-2"></i>保存配置
              </>
            )}
          </button>

          <div className="flex items-center gap-2 px-3 py-1.5 border border-primary/20 rounded-button">
            <span className="text-sm text-foreground/70 mr-1">模拟运行:</span>
            <button
              type="button"
              onClick={() => handleTest(1)}
              disabled={isTesting}
              className="px-3 py-1 rounded bg-success/20 text-success hover:bg-success/30 transition-colors text-sm disabled:opacity-50"
            >
              <i className="fas fa-arrow-up mr-1"></i>UP
            </button>
            <button
              type="button"
              onClick={() => handleTest(0)}
              disabled={isTesting}
              className="px-3 py-1 rounded bg-error/20 text-error hover:bg-error/30 transition-colors text-sm disabled:opacity-50"
            >
              <i className="fas fa-arrow-down mr-1"></i>DOWN
            </button>
          </div>
        </div>

        {/* 模拟运行结果 */}
        {lastTestResult && (
          <div className="mt-4 p-4 rounded-lg border border-primary/20 dark:bg-dark-nav bg-light-nav">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">
                <i className="fas fa-flask mr-2 text-primary"></i>
                模拟运行结果（{getStatusText(lastTestResult.currentStatus)}）
              </span>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  lastTestResult.success
                    ? "bg-success/20 text-success"
                    : "bg-error/20 text-error"
                }`}
              >
                {lastTestResult.success
                  ? "成功"
                  : lastTestResult.timedOut
                  ? "超时"
                  : "失败"}
              </span>
            </div>
            <div className="text-xs text-foreground/60 mb-2">
              耗时 {formatDuration(lastTestResult.durationMs)}
              {lastTestResult.exitCode !== null &&
                ` · 退出码 ${lastTestResult.exitCode}`}
            </div>
            {lastTestResult.errorMessage && (
              <div className="text-sm text-error mb-2">
                {lastTestResult.errorMessage}
              </div>
            )}
            {lastTestResult.output && (
              <pre className="text-xs text-foreground/70 bg-black/10 dark:bg-black/30 p-3 rounded overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                {lastTestResult.output}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* 执行历史 */}
      <div className="dark:bg-dark-card bg-light-card rounded-lg border border-primary/15 hover:border-primary/30 transition-all p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium">
            <i className="fas fa-history mr-2 text-primary"></i>
            执行历史
          </h3>
          <button
            type="button"
            onClick={loadHistory}
            className="text-sm text-primary hover:underline"
          >
            <i className="fas fa-sync mr-1"></i>刷新
          </button>
        </div>

        {executions.length === 0 ? (
          <div className="text-center py-8 text-foreground/60">
            暂无执行记录
          </div>
        ) : (
          <div className="space-y-3">
            {executions.slice(0, 20).map((exec) => {
              const isExpanded = expandedExecutionId === exec.id;
              return (
                <div
                  key={exec.id}
                  className="border border-primary/10 rounded-lg overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedExecutionId(isExpanded ? null : exec.id)
                    }
                    className="w-full flex items-center justify-between p-3 hover:bg-primary/5 transition-colors text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          exec.success
                            ? "bg-success"
                            : exec.timedOut
                            ? "bg-warning"
                            : "bg-error"
                        }`}
                      ></div>
                      <div>
                        <div className="text-sm font-medium">
                          {exec.triggerSource === "simulate"
                            ? "模拟运行"
                            : "状态触发"}
                          {` · ${getStatusText(exec.currentStatus)}`}
                        </div>
                        <div className="text-xs text-foreground/50">
                          {new Date(exec.createdAt).toLocaleString()}
                          {` · 耗时 ${formatDuration(exec.durationMs)}`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          exec.success
                            ? "bg-success/20 text-success"
                            : exec.timedOut
                            ? "bg-warning/20 text-warning"
                            : "bg-error/20 text-error"
                        }`}
                      >
                        {exec.success
                          ? "成功"
                          : exec.timedOut
                          ? "超时"
                          : "失败"}
                      </span>
                      <i
                        className={`fas fa-chevron-${
                          isExpanded ? "up" : "down"
                        } text-foreground/50 text-xs`}
                      ></i>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="p-3 border-t border-primary/10 dark:bg-dark-nav bg-light-nav">
                      {exec.errorMessage && (
                        <div className="text-sm text-error mb-2">
                          {exec.errorMessage}
                        </div>
                      )}
                      {exec.output ? (
                        <pre className="text-xs text-foreground/70 bg-black/10 dark:bg-black/30 p-3 rounded overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                          {exec.output}
                        </pre>
                      ) : (
                        <div className="text-xs text-foreground/50">
                          无输出
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI 帮助弹窗 */}
      {showHelpModal && createPortal(
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[110] flex items-center justify-center overflow-y-auto" onClick={() => setShowHelpModal(false)}>
          <div
            className="dark:bg-dark-card bg-light-card rounded-lg border border-primary/15 shadow-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="sticky top-0 z-10 dark:bg-dark-card bg-light-card border-b border-primary/10 px-6 py-4 flex justify-between items-center">
              <h2 className="text-lg font-bold text-foreground flex items-center">
                <i className="fas fa-magic-wand-sparkles mr-2 text-primary"></i>
                如何让 AI 帮我写脚本
              </h2>
              <button
                type="button"
                onClick={() => setShowHelpModal(false)}
                className="text-foreground/70 hover:text-foreground"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* 说明 */}
              <div className="text-sm text-foreground/70 leading-relaxed">
                你可以用 AI（如 ChatGPT、Claude、通义千问等）帮你生成脚本。
                在下方描述你的需求，点击复制，然后把提示词粘贴给 AI 即可。
              </div>

              {/* 需求输入 */}
              <div className="space-y-2">
                <label className="block text-foreground/80 font-medium">
                  你的需求
                </label>
                <textarea
                  value={userRequirement}
                  onChange={(e) => setUserRequirement(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg dark:bg-dark-input bg-light-input border border-primary/20 focus:border-primary focus:outline-none h-28 text-sm"
                  placeholder={"例如：当监控状态变为 DOWN 时，调用 Cloudflare API 将 DNS 记录切换到备用服务器 IP 1.2.3.4；状态恢复为 UP 时切回原 IP。\n\n尽量描述清楚：\n- 什么状态下执行\n- 调用什么 API / 命令\n- 关键参数（域名、token 等）"}
                />
                <p className="text-xs text-foreground/50">
                  描述得越具体，AI 生成的脚本越准确
                </p>
              </div>

              {/* 提示词预览 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-foreground/80 font-medium">
                    生成的提示词
                  </label>
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    className="bg-gradient-to-r from-primary to-secondary text-white px-4 py-1.5 rounded-button hover:opacity-90 transition-all text-xs flex items-center"
                  >
                    <i className="fas fa-copy mr-1.5"></i>
                    复制提示词
                  </button>
                </div>
                <pre className="text-xs text-foreground/70 dark:bg-dark-nav bg-light-nav border border-primary/10 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto leading-relaxed">
                  {buildPrompt()}
                </pre>
              </div>

              {/* 使用步骤 */}
              <div className="p-4 rounded-lg border border-primary/10 dark:bg-dark-nav bg-light-nav">
                <div className="text-sm font-medium text-foreground/80 mb-2">使用步骤</div>
                <ol className="text-xs text-foreground/60 space-y-1.5 list-decimal list-inside">
                  <li>在上方填写你的具体需求</li>
                  <li>点击「复制提示词」按钮</li>
                  <li>粘贴给任意 AI 对话窗口</li>
                  <li>将 AI 生成的代码复制回上方的脚本编辑器</li>
                  <li>点击「模拟运行」测试效果</li>
                  <li>测试通过后点击「保存配置」并启用</li>
                </ol>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
