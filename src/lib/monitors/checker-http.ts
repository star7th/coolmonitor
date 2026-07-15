import { MonitorHttpConfig, MonitorKeywordConfig, MonitorCheckResult, MONITOR_STATUS, ERROR_MESSAGES } from './types';
import { checkStatusCode, getNetworkErrorMessage } from './utils';
import { proxyFetch, standardFetch } from './proxy-fetch';
import { getAllProxySettings, SETTINGS_KEYS } from '../settings';
import sslChecker from "ssl-checker";
import { sendStatusChangeNotifications } from './notification-service';

// 证书通知缓存，避免同一天重复发送通知
const certNotificationCache = new Map<string, Set<string>>();

// 检查代理是否启用
async function isProxyEnabled(): Promise<boolean> {
  try {
    const proxySettings = await getAllProxySettings();
    return proxySettings[SETTINGS_KEYS.PROXY_ENABLED] === 'true';
  } catch {
    return false;
  }
}

// 检查是否需要发送证书通知
async function checkAndSendCertNotification(
  monitorId: string,
  monitorName: string,
  daysRemaining: number,
  status: number
) {
  // 只对已过期或7天内过期的证书发送通知
  if (!(status === MONITOR_STATUS.DOWN || (status === MONITOR_STATUS.UP && daysRemaining <= 7))) {
    return;
  }
  
  // 检查是否是中午12点左右（允许5分钟误差）
  const now = new Date();
  const isNoonTime = now.getHours() === 12 && now.getMinutes() < 5;
  
  // 如果不是中午12点，则不发送通知
  if (!isNoonTime) {
    return;
  }
  
  // 获取今天的日期作为缓存键
  const today = now.toISOString().split('T')[0]; 
  
  // 确定通知类型和消息
  let notificationType = '';
  let notificationMessage = '';
  
  if (status === MONITOR_STATUS.DOWN) {
    notificationType = 'expired';
    notificationMessage = `【严重警告】${monitorName} 的SSL证书已过期！请立即处理！`;
  } else {
    notificationType = `expiring-${daysRemaining}`;
    notificationMessage = `【证书到期提醒】${monitorName} 的SSL证书将在 ${daysRemaining} 天后过期，请及时更新证书。`;
  }
  
  // 检查今天是否已发送过该类型的通知
  const cacheKey = `${monitorId}-${today}`;
  const monitorCache = certNotificationCache.get(cacheKey) || new Set();
  
  if (monitorCache.has(notificationType)) {
    return;
  }
  
  // 发送通知
  try {
    await sendStatusChangeNotifications(
      monitorId,
      status,
      notificationMessage,
      null, // 不传入prevStatus，确保通知会发送
      { standalone: true } // 独立通知：不参与上下线状态机去重，避免污染故障/恢复通知缓存
    );
    
    // 标记为已通知
    monitorCache.add(notificationType);
    certNotificationCache.set(cacheKey, monitorCache);
    
    console.log(`已发送 ${monitorName} 的证书 ${notificationType} 通知`);
  } catch (error) {
    console.error(`发送 ${monitorName} 的证书通知失败:`, error);
  }
}

// 每天0点清理证书通知缓存
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    certNotificationCache.clear();
    console.log('证书通知缓存已清理');
  }
}, 60000); // 每分钟检查一次

// HTTP监控检查（单次执行，不包含重试逻辑）
async function checkHttpSingle(config: MonitorHttpConfig): Promise<MonitorCheckResult> {
  const { 
    url, 
    httpMethod = 'GET', 
    statusCodes = '200-299', 
    maxRedirects = 10, 
    requestBody = '', 
    requestHeaders = '',
    connectTimeout = 10, // 默认10秒超时
    notifyCertExpiry = false,
    monitorId = '',
    monitorName = ''
    // ignoreTls 在当前前端实现中未被使用
  } = config;
  
  if (!url) {
    return {
      status: MONITOR_STATUS.DOWN,
      message: 'URL不能为空',
      ping: 0
    };
  }
  
  const startTime = Date.now();
  
  try {
    // 如果启用了证书通知且是HTTPS URL，先检查证书状态
    if (notifyCertExpiry && url.startsWith('https://')) {
      try {
        // 复用HTTPS证书检查逻辑进行证书检查
        const certResult = await checkHttpsCertificate({ 
          url, 
          connectTimeout, // 传递用户配置的超时时间
          monitorId, 
          monitorName 
        });
        
        // 如果证书检查失败（DOWN状态），直接返回证书检查失败的结果
        if (certResult.status === MONITOR_STATUS.DOWN) {
          return certResult;
        }
        
        // 如果证书检查显示将要过期，我们将这个信息保存下来，但继续检查HTTP状态
        // 稍后会将证书警告添加到正常的HTTP检查消息中
        if (certResult.message.includes('【警告】')) {
          // 保存证书警告消息供后续使用
          config.certWarning = certResult.message;
        }
      } catch (certError) {
        console.warn('在HTTP监控中检查证书时出错:', certError);
        // 即使证书检查失败，我们也继续执行HTTP检查
      }
    }
  
    // 准备请求选项
    const requestOptions: RequestInit = {
      method: httpMethod,
      redirect: maxRedirects > 0 ? 'follow' : 'manual',
      signal: AbortSignal.timeout(connectTimeout * 1000), // 转换为毫秒
      headers: {}
    };
    
    // 添加自定义请求头
    if (requestHeaders) {
      try {
        const headersObj = typeof requestHeaders === 'string' ? 
          JSON.parse(requestHeaders) : requestHeaders;
        
        Object.keys(headersObj).forEach(key => {
          (requestOptions.headers as Record<string, string>)[key] = headersObj[key];
        });
      } catch (e) {
        console.warn(`解析请求头失败:`, e);
      }
    }
    
    // 添加请求体
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
      requestOptions.body = requestBody;
    }
    
    // 检查是否启用代理
    const proxyEnabled = await isProxyEnabled();
    
    // 发送请求 - 根据配置使用代理或直接请求
    let response;
    try {
      response = proxyEnabled ? 
        await proxyFetch(url, requestOptions) : 
        await standardFetch(url, requestOptions);
    } catch (error) {
      const errorMessage = getNetworkErrorMessage(error);
      const actualTime = Date.now() - startTime;
      
      return {
        status: MONITOR_STATUS.DOWN,
        message: errorMessage,
        ping: actualTime
      };
    }
    
    const responseTime = Date.now() - startTime;
    
    // 检查状态码是否符合预期
    const isStatusValid = checkStatusCode(response.status, statusCodes);
    
    if (isStatusValid) {
      // 构建成功消息
      let message = `状态码: ${response.status}`;
      
      // 如果有证书警告，添加到消息中
      if (config.certWarning) {
        message += ` | ${config.certWarning}`;
      }
      
      return {
        status: MONITOR_STATUS.UP,
        message,
        ping: responseTime
      };
    } else {
      return {
        status: MONITOR_STATUS.DOWN,
        message: `状态码不符合预期: ${response.status}`,
        ping: responseTime
      };
    }
  } catch (error) {
    const errorMessage = getNetworkErrorMessage(error);
    const actualTime = Date.now() - startTime;
    
    // 调试日志：如果是超时错误，打印实际耗时
    if (error instanceof Error && (error.name === 'TimeoutError' || error.message.includes('timeout'))) {
      console.log(`[HTTP检查] 外层超时错误! 配置超时: ${connectTimeout}秒, 实际耗时: ${actualTime}毫秒`);
    } else {
      console.log(`[HTTP检查] 外层其他错误: ${errorMessage}, 耗时: ${actualTime}毫秒`);
    }
    
    return {
      status: MONITOR_STATUS.DOWN,
      message: errorMessage,
      ping: actualTime
    };
  }
}

// HTTP监控检查（包含重试逻辑）
export async function checkHttp(config: MonitorHttpConfig): Promise<MonitorCheckResult> {
  const { retries = 0, retryInterval = 60 } = config;
  
  // 如果没有设置重试次数，直接执行单次检查
  if (retries === 0) {
    return await checkHttpSingle(config);
  }
  
  // 执行首次检查
  const result = await checkHttpSingle(config);
  
  // 如果首次检查成功，直接返回
  if (result.status === MONITOR_STATUS.UP) {
    return result;
  }
  
  // 如果配置了重试次数且首次检查失败，进行重试
  if (retries > 0) {
    for (let i = 0; i < retries; i++) {
      // 等待重试间隔时间（秒）
      await new Promise(resolve => setTimeout(resolve, retryInterval * 1000));
      
      // 执行重试检查
      const retryResult = await checkHttpSingle(config);
      
      if (retryResult.status === MONITOR_STATUS.UP) {
        return {
          ...retryResult,
          message: `重试成功 (${i + 1}/${retries}): ${retryResult.message}`
        };
      }
    }
    
    return {
      ...result,
      message: `重试${retries}次后仍然失败: ${result.message}`
    };
  }
  
  return result;
}

// 关键词监控检查（单次执行，不包含重试逻辑）
async function checkKeywordSingle(config: MonitorKeywordConfig): Promise<MonitorCheckResult> {
  // 统一与前端配置项，确保兼容性处理
  const { 
    url, 
    httpMethod = 'GET', 
    keyword = '', 
    statusCodes = '200-299', 
    maxRedirects = 10, 
    requestBody = '', 
    requestHeaders = '',
    connectTimeout = 10 // 默认10秒超时
    // ignoreTls 在当前前端实现中未被使用
  } = config;
  

  
  if (!url) {
    return {
      status: MONITOR_STATUS.DOWN,
      message: 'URL不能为空',
      ping: 0
    };
  }
  
  if (!keyword) {
    return {
      status: MONITOR_STATUS.DOWN,
      message: '关键词不能为空',
      ping: 0
    };
  }
  
  const startTime = Date.now();
  
  try {
    // 准备请求选项（与HTTP检查相同）
    const requestOptions: RequestInit = {
      method: httpMethod,
      redirect: maxRedirects > 0 ? 'follow' : 'manual',
      signal: AbortSignal.timeout(connectTimeout * 1000), // 转换为毫秒
      headers: {}
    };
    
    // 添加自定义请求头
    if (requestHeaders) {
      try {
        const headersObj = typeof requestHeaders === 'string' ? 
          JSON.parse(requestHeaders) : requestHeaders;
        
        Object.keys(headersObj).forEach(key => {
          (requestOptions.headers as Record<string, string>)[key] = headersObj[key];
        });
      } catch (e) {
        console.warn(`解析请求头失败:`, e);
      }
    }
    
    // 添加请求体
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
      requestOptions.body = requestBody;
    }
    
    // 检查是否启用代理
    const proxyEnabled = await isProxyEnabled();
    
    // 发送请求 - 根据配置使用代理或直接请求
    let response;
    try {
      response = proxyEnabled ? 
        await proxyFetch(url, requestOptions) : 
        await standardFetch(url, requestOptions);
    } catch (error) {
      // 根据是否启用代理返回不同的错误消息
      const errorMessage = getNetworkErrorMessage(error);
      return {
        status: MONITOR_STATUS.DOWN,
        message: proxyEnabled ? `代理连接失败: ${errorMessage}` : errorMessage,
        ping: Date.now() - startTime
      };
    }
    
    const responseTime = Date.now() - startTime;
    
    // 检查状态码是否符合预期
    const isStatusValid = checkStatusCode(response.status, statusCodes);
    
    if (!isStatusValid) {
      return {
        status: MONITOR_STATUS.DOWN,
        message: `状态码不符合预期: ${response.status}`,
        ping: responseTime
      };
    }
    
    // 检查响应内容中是否包含关键词
    const responseText = await response.text();
    
    // 支持多个关键词，用英文逗号分隔，每个关键词之间是"或"的关系
    const keywords = keyword.split(',').map(k => k.trim()).filter(k => k.length > 0);
    let keywordFound = false;
    let foundKeyword = '';
    
    for (const kw of keywords) {
      if (responseText.includes(kw)) {
        keywordFound = true;
        foundKeyword = kw;
        break;
      }
    }
    
    if (keywordFound) {
      const keywordInfo = keywords.length > 1 ? ` (匹配到: ${foundKeyword})` : '';
      return {
        status: MONITOR_STATUS.UP,
        message: `找到关键词${keywordInfo}，状态码: ${response.status}${proxyEnabled ? ' (使用代理)' : ''}`,
        ping: responseTime
      };
    } else {
      const keywordInfo = keywords.length > 1 ? ` (检查了 ${keywords.length} 个关键词)` : '';
      return {
        status: MONITOR_STATUS.DOWN,
        message: `${ERROR_MESSAGES.KEYWORD_NOT_FOUND}${keywordInfo}`,
        ping: responseTime
      };
    }
  } catch (error) {
    const errorMessage = getNetworkErrorMessage(error);
    return {
      status: MONITOR_STATUS.DOWN,
      message: errorMessage,
      ping: Date.now() - startTime
    };
  }
}

// 关键词监控检查（包含重试逻辑）
export async function checkKeyword(config: MonitorKeywordConfig): Promise<MonitorCheckResult> {
  const { retries = 0, retryInterval = 60 } = config;
  
  // 如果没有设置重试次数，直接执行单次检查
  if (retries === 0) {
    return await checkKeywordSingle(config);
  }
  
  // 执行首次检查
  const result = await checkKeywordSingle(config);
  
  // 如果首次检查成功，直接返回
  if (result.status === MONITOR_STATUS.UP) {
    return result;
  }
  
  // 如果配置了重试次数且首次检查失败，进行重试
  if (retries > 0) {
    for (let i = 0; i < retries; i++) {
      // 等待重试间隔时间（秒）
      await new Promise(resolve => setTimeout(resolve, retryInterval * 1000));
      
      // 执行重试检查
      const retryResult = await checkKeywordSingle(config);
      
      if (retryResult.status === MONITOR_STATUS.UP) {
        return {
          ...retryResult,
          message: `重试成功 (${i + 1}/${retries}): ${retryResult.message}`
        };
      }
    }
    
    return {
      ...result,
      message: `重试${retries}次后仍然失败: ${result.message}`
    };
  }
  
  return result;
}

// HTTPS证书监控检查
export async function checkHttpsCertificate(config: MonitorHttpConfig): Promise<MonitorCheckResult> {
  const { 
    url,
    connectTimeout = 10, // 默认10秒超时
    monitorId, // 新增参数，用于发送通知
    monitorName // 新增参数，用于发送通知
    // ignoreTls 参数在证书监控中不使用，因为我们始终需要验证证书
  } = config;
  

  
  if (!url) {
    return {
      status: MONITOR_STATUS.DOWN,
      message: 'URL不能为空',
      ping: 0
    };
  }
  
  const startTime = Date.now();
  
  try {
    // 检查URL是否是HTTPS
    if (!url.startsWith('https://')) {
      return {
        status: MONITOR_STATUS.DOWN,
        message: '仅支持HTTPS URL (必须以https://开头)',
        ping: 0
      };
    }

    // 从URL中提取主机名和端口
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const port = urlObj.port || '443'; // 如果没有指定端口，默认使用443
    
    let daysRemaining = -1;
    let certificateWarning = '';
    let certInfo: { valid: boolean; daysRemaining: number } | null = null;
    
    try {
      // 使用 ssl-checker 库检查SSL证书，传入端口信息和超时设置
      certInfo = await sslChecker(hostname, {
        method: "GET",
        port: parseInt(port),
        timeout: connectTimeout * 1000 // 转换为毫秒
      });
      
      // 获取证书剩余天数
      if (certInfo && typeof certInfo.daysRemaining === 'number') {
        daysRemaining = certInfo.daysRemaining;
      }
      
      // 如果有监控ID和名称，并且证书将要过期或已过期，检查是否需要发送通知
      if (monitorId && monitorName && certInfo) {
        // 证书状态：正常 -> UP，已过期 -> DOWN
        const certStatus = certInfo.valid === true ? MONITOR_STATUS.UP : MONITOR_STATUS.DOWN;
        
        // 检查并发送证书通知（如果需要）
        await checkAndSendCertNotification(monitorId, monitorName, daysRemaining, certStatus);
      }
      
      // 如果证书将在7天内过期，发出提醒但保持状态为UP
      if (daysRemaining <= 7) {
        certificateWarning = `【警告】证书将在${daysRemaining}天后过期，请及时更新`;
      }

      // 检查证书是否有效
      if (certInfo && certInfo.valid === false) {
        return {
          status: MONITOR_STATUS.DOWN,
          message: '证书无效',
          ping: Date.now() - startTime
        };
      }

      // 构建返回消息，包含证书剩余天数信息
      let message = `HTTPS证书有效`;
      
      // 添加剩余天数信息，不论是否有警告
      if (daysRemaining > 0) {
        message += ` (剩余${daysRemaining}天)`;
        
        // 如果有警告，再另外添加警告信息
        if (certificateWarning) {
          message += `. ${certificateWarning}`;
        }
      }
      
      return {
        status: MONITOR_STATUS.UP,
        message: message,
        ping: Date.now() - startTime
      };
    } catch (certError) {
      console.warn('获取证书信息时出错:', certError);
      return {
        status: MONITOR_STATUS.DOWN,
        message: `证书检查失败: ${getNetworkErrorMessage(certError)}`,
        ping: Date.now() - startTime
      };
    }
  } catch (error) {
    const errorMessage = getNetworkErrorMessage(error);
    return {
      status: MONITOR_STATUS.DOWN,
      message: errorMessage,
      ping: Date.now() - startTime
    };
  }
} 