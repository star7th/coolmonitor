import { useState, useEffect } from "react";
import { toast } from "react-hot-toast";
import { createPortal } from "react-dom";
import { BasicInfoSection } from "./components/BasicInfoSection";
import { MonitorSettingsSection } from "./components/MonitorSettingsSection";
import { NotificationSection } from "./components/NotificationSection";
import { AdvancedOptionsSection } from "./components/AdvancedOptionsSection";
import { DatabaseOptionsSection } from "./components/DatabaseOptionsSection";
import { ScriptActionSection } from "./components/ScriptActionSection";
import { SimpleNotificationBinding } from "@/types/monitor";
import { generatePushToken, MonitorConfig } from "@/lib/monitors";

// 监控项数据接口
interface MonitorData {
  id?: string;
  name: string;
  type: string;
  config?: Record<string, string | number | boolean | null>;
  interval?: number;
  retries?: number;
  retryInterval?: number;
  resendInterval?: number;
  active?: boolean;
  upsideDown?: boolean;
  description?: string;
  groupId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  notificationBindings?: SimpleNotificationBinding[];
  statusHistory?: Array<{
    id: string;
    status: number;
    message?: string;
    ping?: number;
    timestamp: string;
  }>;
}

interface MonitorFormProps {
  isOpen: boolean;
  onClose: () => void;
  editMode?: boolean;
  initialData?: MonitorData | null;
}

export function MonitorForm({ isOpen, onClose, editMode = false, initialData = null }: MonitorFormProps) {
  // 基本信息
  const [activeTab, setActiveTab] = useState<'basic' | 'notification' | 'advanced' | 'script'>('basic');
  const [monitorType, setMonitorType] = useState("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  
  // 监控设置
  const [interval, setInterval] = useState("60");
  const [retries, setRetries] = useState("0");
  const [retryInterval, setRetryInterval] = useState("60");
  const [resendInterval, setResendInterval] = useState("0");
  
  // 通知绑定
  const [notificationBindings, setNotificationBindings] = useState<SimpleNotificationBinding[]>([]);
  
  // HTTP相关
  const [httpMethod, setHttpMethod] = useState("GET");
  const [statusCodes, setStatusCodes] = useState("200-299");
  const [requestBody, setRequestBody] = useState("");
  const [requestHeaders, setRequestHeaders] = useState("");
  const [maxRedirects, setMaxRedirects] = useState("10");
  const [connectTimeout, setConnectTimeout] = useState("10");
  
  // 验证
  const [keyword, setKeyword] = useState("");
  
  // 数据库相关
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [query, setQuery] = useState("");
  
  // 高级选项
  const [ignoreTls, setIgnoreTls] = useState(false);
  const [upsideDown, setUpsideDown] = useState(false);
  const [notifyCertExpiry, setNotifyCertExpiry] = useState(false);
  
  // 提交状态
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  
  const [isMounted, setIsMounted] = useState(false);
  
  useEffect(() => {
    setIsMounted(true);
    
    // 打开表单时禁止背景滚动
    if (isOpen) {
      document.body.style.overflow = "hidden";
    }
    
    return () => {
      // 关闭表单时恢复背景滚动
      document.body.style.overflow = "auto";
    };
  }, [isOpen]);
  
  // 在编辑模式下加载初始数据
  useEffect(() => {
    if (editMode && initialData) {
      // 基本信息
      setMonitorType(initialData.type || "http");
      setName(initialData.name || "");
      setGroupId(initialData.groupId || null);
      
      // 根据监控类型设置特定字段
      if (initialData.config) {
        if (["http", "keyword", "https-cert"].includes(initialData.type)) {
          setUrl(initialData.config.url as string || "");
          setHttpMethod(initialData.config.httpMethod as string || "GET");
          setStatusCodes(initialData.config.statusCodes as string || "200-299");
          setMaxRedirects(String(initialData.config.maxRedirects || "10"));
          setConnectTimeout(String(initialData.config.connectTimeout || "10"));
          setRequestBody(initialData.config.requestBody as string || "");
          setRequestHeaders(initialData.config.requestHeaders as string || "");
          
          if (initialData.type === "keyword") {
            setKeyword(initialData.config.keyword as string || "");
          }
          
          // 加载证书到期通知设置
          if (initialData.type === "http") {
            setNotifyCertExpiry(Boolean(initialData.config.notifyCertExpiry) || false);
          }
        }
        
        if (["port", "mysql", "redis", "icmp"].includes(initialData.type)) {
          setHostname(initialData.config.hostname as string || "");
          
          if (["port", "mysql", "redis"].includes(initialData.type)) {
            setPort(String(initialData.config.port || ""));
          }
          
          if (["mysql", "redis"].includes(initialData.type)) {
            setUsername(initialData.config.username as string || "");
            setPassword(initialData.config.password as string || "");
            setDatabase(initialData.config.database as string || "");
            setQuery(initialData.config.query as string || "");
          }
        }
        
        // 其他设置
        setIgnoreTls(Boolean(initialData.config.ignoreTls) || false);
      }
      
      // 监控设置
      setInterval(String(initialData.interval || "60"));
      setRetries(String(initialData.retries || "0"));
      setRetryInterval(String(initialData.retryInterval || "60"));
      setResendInterval(String(initialData.resendInterval || "0"));
      
      // 通知绑定关系
      if (initialData.notificationBindings && Array.isArray(initialData.notificationBindings)) {
        setNotificationBindings(initialData.notificationBindings);
      }
      
      // 高级选项
      setUpsideDown(Boolean(initialData.upsideDown) || false);
    }
  }, [editMode, initialData]);
  
  // 添加一个用于处理Push监控配置的函数
  // const handlePushConfigChange = (key: string, value: any) => {
  //   if (key === 'pushToken' && monitorType === 'push') {
  //     console.log(`保存Push配置: ${key}=${value}`);
  //   }
  // };
  
  // 处理通知绑定变更
  const handleNotificationBindingsChange = (bindings: SimpleNotificationBinding[]) => {
    setNotificationBindings(bindings);
  };
  
  // 处理函数
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // 重置错误状态
    setFormError(null);
    
    // 验证表单
    if (!name.trim()) {
      setFormError("监控名称不能为空");
      return;
    }
    
    if ((monitorType === "http" || monitorType === "keyword" || monitorType === "https-cert") && !url.trim()) {
      setFormError("URL不能为空");
      return;
    }
    
    // HTTPS证书检查
    if (monitorType === "https-cert" && !url.trim().startsWith("https://")) {
      setFormError("HTTPS证书监控必须使用HTTPS URL（以https://开头）");
      return;
    }
    
    if (["port", "mysql", "redis"].includes(monitorType)) {
      if (!hostname.trim()) {
        setFormError("主机名不能为空");
        return;
      }
      
      if (!port.trim() || isNaN(parseInt(port))) {
        setFormError("端口必须是有效的数字");
        return;
      }
    }
    
    if (monitorType === "icmp" && !hostname.trim()) {
      setFormError("主机名不能为空");
      return;
    }
    
    if (monitorType === "keyword" && !keyword.trim()) {
      setFormError("关键字不能为空");
      return;
    }
    
    // 构建监控数据对象
    const config = {
      url: (monitorType === "http" || monitorType === "keyword" || monitorType === "https-cert") ? url : null,
      hostname: ["port", "mysql", "redis", "icmp"].includes(monitorType) ? hostname : null,
      port: ["port", "mysql", "redis"].includes(monitorType) ? parseInt(port) : null,
              httpMethod: ["http", "keyword"].includes(monitorType) ? httpMethod : null,
        statusCodes: ["http", "keyword"].includes(monitorType) ? statusCodes : null,
        maxRedirects: ["http", "keyword", "https-cert"].includes(monitorType) ? parseInt(maxRedirects) : null,
        connectTimeout: ["http", "keyword", "https-cert"].includes(monitorType) ? parseInt(connectTimeout) : null,
      keyword: monitorType === "keyword" ? keyword : null,
      ignoreTls,
      notifyCertExpiry: monitorType === "http" ? notifyCertExpiry : null,
      username: ["mysql", "redis"].includes(monitorType) ? username : null,
      password: ["mysql", "redis"].includes(monitorType) ? password : null,
      database: ["mysql"].includes(monitorType) ? database : null,
      query: ["mysql", "redis"].includes(monitorType) ? query : null,
      requestBody: ["http", "keyword"].includes(monitorType) ? requestBody || null : null,
      requestHeaders: ["http", "keyword"].includes(monitorType) ? requestHeaders || null : null,
      // 为Push监控添加token - 确保总是使用一个新值或现有值
      pushToken: monitorType === "push" ? 
        (initialData?.config?.pushToken as string || localStorage.getItem(`push_token_${initialData?.id || 'new'}`) || generatePushToken()) : null,
      pushInterval: monitorType === "push" ? parseInt(interval) : null,
      // ICMP Ping特定配置
      packetCount: monitorType === "icmp" ? 4 : null,
      maxPacketLoss: monitorType === "icmp" ? 0 : null,
      maxResponseTime: monitorType === "icmp" ? null : null,
    };
    
    // 保存token到localStorage以防止刷新丢失
    if (monitorType === "push" && config.pushToken) {
      localStorage.setItem(`push_token_${initialData?.id || 'new'}`, config.pushToken as string);
    }
    
    const monitorData = {
      name,
      type: monitorType,
      config,
      interval: parseInt(interval),
      retries: parseInt(retries),
      retryInterval: parseInt(retryInterval),
      resendInterval: parseInt(resendInterval),
      upsideDown,
      groupId,
      notificationBindings
    };
    
    // 如果是编辑模式，则添加ID
    if (editMode && initialData?.id) {
      Object.assign(monitorData, { id: initialData.id });
    }
    
    try {
      setIsSubmitting(true);
      
      // 根据是新增还是编辑选择不同的API端点和方法
      const apiUrl = editMode 
        ? `/api/monitors/${initialData?.id}` 
        : '/api/monitors';
      
      const method = editMode ? 'PUT' : 'POST';
      
      // 发送数据到API
      const response = await fetch(apiUrl, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(monitorData),
      });
      
      if (!response.ok) {
        // 获取错误信息
        const errorData = await response.json();
        throw new Error(errorData.error || `${editMode ? '更新' : '创建'}监控项失败`);
      }
      
      // 显示成功消息
      toast.success(`监控项${editMode ? '更新' : '创建'}成功`);
      
      // 关闭表单
      onClose();
      
      // 延迟后刷新页面以显示更新后的监控列表
      setTimeout(() => {
        window.location.reload();
      }, 300);
      
    } catch (error) {
      if (error instanceof Error) {
        setFormError(error.message);
      } else {
        setFormError(`${editMode ? '更新' : '创建'}监控项失败，请稍后重试`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // 客户端环境检查
  if (!isMounted || !isOpen) return null;

  const content = (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center overflow-y-auto">
      <div className="dark:bg-dark-card bg-light-card rounded-lg border border-primary/15 shadow-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 dark:bg-dark-card bg-light-card border-b border-primary/10 px-6 py-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-foreground">{editMode ? '编辑' : '添加'}监控项</h2>
          <button 
            onClick={onClose}
            className="text-foreground/70 hover:text-foreground"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>
          
        {/* 选项卡 */}
        <div className="sticky top-[60px] z-10 dark:bg-dark-card bg-light-card flex border-b border-primary/10">
          <button
            className={`px-6 py-3 ${activeTab === 'basic' 
              ? 'text-primary border-b-2 border-primary font-medium' 
              : 'text-foreground/70 hover:text-foreground'}`}
            onClick={() => setActiveTab('basic')}
          >
            基础设置
          </button>
          <button
            className={`px-6 py-3 ${activeTab === 'notification' 
              ? 'text-primary border-b-2 border-primary font-medium' 
              : 'text-foreground/70 hover:text-foreground'}`}
            onClick={() => setActiveTab('notification')}
          >
            通知设置
          </button>
          <button
            className={`px-6 py-3 ${activeTab === 'advanced' 
              ? 'text-primary border-b-2 border-primary font-medium' 
              : 'text-foreground/70 hover:text-foreground'}`}
            onClick={() => setActiveTab('advanced')}
          >
            高级选项
          </button>
          <button
            className={`px-6 py-3 ${activeTab === 'script' 
              ? 'text-primary border-b-2 border-primary font-medium' 
              : 'text-foreground/70 hover:text-foreground'}`}
            onClick={() => setActiveTab('script')}
          >
            脚本动作
          </button>
        </div>
          
        {/* 表单内容 */}
        <form onSubmit={(e) => {
          e.preventDefault();
          // 脚本动作 Tab 有自己独立的保存逻辑，不提交监控项表单
          if (activeTab === 'script') return;
          handleSubmit(e);
        }}>
        <div className="p-6">
            {/* 错误信息显示 */}
            {formError && (
              <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg text-error">
                    <div className="flex items-center">
                  <i className="fas fa-exclamation-circle mr-2"></i>
                  <span>{formError}</span>
                </div>
            </div>
          )}
          
            {activeTab === 'basic' && (
            <div className="space-y-6">
                {/* 基础信息 */}
                <BasicInfoSection 
                  monitorType={monitorType}
                  setMonitorType={setMonitorType}
                  name={name}
                  setName={setName}
                  url={url}
                  setUrl={setUrl}
                  hostname={hostname}
                  setHostname={setHostname}
                  port={port}
                  setPort={setPort}
                  keyword={keyword}
                  setKeyword={setKeyword}
                  groupId={groupId}
                  setGroupId={setGroupId}
                  config={initialData?.config as unknown as MonitorConfig || {}}
                  onConfigChange={(key, value) => {
                    // 这里不需要调用setConfig，因为在handleSubmit中已经正确构建了config对象
                    if (key === 'pushToken' && monitorType === 'push') {
                      // 将token保存到localStorage，以便在handleSubmit中使用
                      localStorage.setItem(`push_token_${initialData?.id || 'new'}`, value as string);
                    }
                  }}
                />
                
                {/* 数据库选项 */}
                {["mysql", "redis"].includes(monitorType) && (
                  <DatabaseOptionsSection
                    monitorType={monitorType}
                    username={username}
                    setUsername={setUsername}
                    password={password}
                    setPassword={setPassword}
                    database={database}
                    setDatabase={setDatabase}
                    query={query}
                    setQuery={setQuery}
                  />
                )}
                
                {/* 监控设置 */}
                <MonitorSettingsSection 
                  interval={interval}
                  setInterval={setInterval}
                  retries={retries}
                  setRetries={setRetries}
                  retryInterval={retryInterval}
                  setRetryInterval={setRetryInterval}
                  resendInterval={resendInterval}
                  setResendInterval={setResendInterval}
                  />
              </div>
            )}
            
            {activeTab === 'notification' && (
              <NotificationSection 
                initialBindings={notificationBindings}
                onBindingsChange={handleNotificationBindingsChange}
                monitorId={initialData?.id}
              />
            )}
            
            {activeTab === 'advanced' && (
              <AdvancedOptionsSection 
                monitorType={monitorType}
                httpMethod={httpMethod}
                setHttpMethod={setHttpMethod}
                statusCodes={statusCodes}
                setStatusCodes={setStatusCodes}
                requestBody={requestBody}
                setRequestBody={setRequestBody}
                requestHeaders={requestHeaders}
                setRequestHeaders={setRequestHeaders}
                ignoreTls={ignoreTls}
                setIgnoreTls={setIgnoreTls}
                            maxRedirects={maxRedirects}
                setMaxRedirects={setMaxRedirects}
                connectTimeout={connectTimeout}
                setConnectTimeout={setConnectTimeout}
                upsideDown={upsideDown}
                setUpsideDown={setUpsideDown}
                notifyCertExpiry={notifyCertExpiry}
                setNotifyCertExpiry={setNotifyCertExpiry}
              />
            )}
            
            {activeTab === 'script' && (
              editMode && initialData?.id ? (
                <ScriptActionSection monitorId={initialData.id} />
              ) : (
                <div className="dark:bg-dark-card bg-light-card rounded-lg border border-primary/15 p-8 text-center">
                  <i className="fas fa-code text-primary text-4xl mb-4"></i>
                  <h3 className="text-lg font-medium mb-2">自定义脚本动作</h3>
                  <p className="text-sm text-foreground/60 max-w-md mx-auto leading-relaxed">
                    当监控状态变化（UP↔DOWN）时，可自动执行你配置的 Node.js 脚本，
                    实现自动化故障响应，例如切换 DNS、重启服务、调用 API 等。
                  </p>
                  <p className="text-sm text-warning mt-4">
                    <i className="fas fa-info-circle mr-1"></i>
                    请先保存监控项，再回来配置脚本动作
                  </p>
                </div>
              )
            )}
        </div>
        
        {/* 底部操作按钮 - 脚本动作 Tab 下隐藏，该 Tab 有自己的保存按钮 */}
        {activeTab !== 'script' && (
        <div className="sticky bottom-0 z-10 dark:bg-dark-card bg-light-card border-t border-primary/10 px-6 py-4 flex justify-between items-center">
          <button 
              type="button"
            onClick={onClose}
            className="px-6 py-2 border border-primary/30 rounded-button text-foreground hover:bg-primary/5 transition-colors"
              disabled={isSubmitting}
          >
            取消
          </button>
            <button 
              type="submit"
              className="bg-gradient-to-r from-primary to-secondary text-white px-8 py-2 rounded-button hover:opacity-90 shadow-glow-sm transition-all flex items-center"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <i className="fas fa-circle-notch fa-spin mr-2"></i>
                  保存中...
                </>
              ) : '保存'}
          </button>
        </div>
        )}
        </form>
      </div>
    </div>
  );

  // 使用 Portal 渲染到文档根节点
  return createPortal(content, document.body);
} 