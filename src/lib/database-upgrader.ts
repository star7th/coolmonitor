import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

// 数据库版本定义
const DB_VERSIONS = [
  {
    version: 1,
    name: '初始数据库结构',
    requiredTables: ['User', 'Session'],
    check: async () => {
      return await hasTable('User') && await hasTable('Session');
    }
  },
  {
    version: 2,
    name: '系统配置表',
    requiredTables: ['SystemConfig'],
    check: async () => {
      return await hasTable('SystemConfig');
    },
    upgrade: async () => {
      if (!(await hasTable('SystemConfig'))) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "SystemConfig" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "key" TEXT NOT NULL,
            "value" TEXT NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
          );
          CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");
        `);

        // 插入默认配置
        const configs = [
          { key: 'timezone', value: 'Asia/Shanghai' },
          { key: 'data_retention_days', value: '90' },
          { key: 'proxy_enabled', value: 'false' },
          { key: 'proxy_server', value: '' },
          { key: 'proxy_port', value: '' },
          { key: 'proxy_username', value: '' },
          { key: 'proxy_password', value: '' }
        ];

        for (const config of configs) {
          await prisma.systemConfig.create({
            data: {
              ...config,
            }
          });
        }
      }
    }
  },
  {
    version: 3,
    name: '用户表更新',
    check: async () => {
      return await hasColumn('User', 'username') && 
             !await isColumnRequired('User', 'email');
    },
    upgrade: async () => {
      // 检查username列是否存在
      if (!await hasColumn('User', 'username')) {
        // 添加username列
        await prisma.$executeRawUnsafe(`
          PRAGMA defer_foreign_keys=ON;
          PRAGMA foreign_keys=OFF;
          CREATE TABLE "new_User" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "username" TEXT NOT NULL,
            "name" TEXT,
            "email" TEXT,
            "password" TEXT NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            "isAdmin" BOOLEAN NOT NULL DEFAULT false
          );
          INSERT INTO "new_User" ("createdAt", "email", "id", "isAdmin", "name", "password", "updatedAt") 
          SELECT "createdAt", "email", "id", "isAdmin", "name", "password", "updatedAt" FROM "User";

          -- 如果User表存在，更新username为name的值或email的值
          UPDATE "new_User" SET "username" = COALESCE("name", "email") WHERE "username" IS NULL;
          
          DROP TABLE "User";
          ALTER TABLE "new_User" RENAME TO "User";
          CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
          PRAGMA foreign_keys=ON;
          PRAGMA defer_foreign_keys=OFF;
        `);
      } else if (await isColumnRequired('User', 'email')) {
        // 如果email是必需的，修改为可选
        await prisma.$executeRawUnsafe(`
          PRAGMA defer_foreign_keys=ON;
          PRAGMA foreign_keys=OFF;
          CREATE TABLE "new_User" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "username" TEXT NOT NULL,
            "name" TEXT,
            "email" TEXT,
            "password" TEXT NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            "isAdmin" BOOLEAN NOT NULL DEFAULT false
          );
          INSERT INTO "new_User" ("createdAt", "email", "id", "isAdmin", "name", "password", "updatedAt", "username") 
          SELECT "createdAt", "email", "id", "isAdmin", "name", "password", "updatedAt", "username" FROM "User";
          DROP TABLE "User";
          ALTER TABLE "new_User" RENAME TO "User";
          CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
          PRAGMA foreign_keys=ON;
          PRAGMA defer_foreign_keys=OFF;
        `);
      }
    }
  },
  {
    version: 4,
    name: '监控表',
    requiredTables: ['Monitor', 'MonitorStatus'],
    check: async () => {
      return await hasTable('Monitor') && await hasTable('MonitorStatus');
    },
    upgrade: async () => {
      if (!await hasTable('Monitor')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "Monitor" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "name" TEXT NOT NULL,
            "type" TEXT NOT NULL,
            "config" JSONB NOT NULL,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "interval" INTEGER NOT NULL DEFAULT 60,
            "retries" INTEGER NOT NULL DEFAULT 0,
            "retryInterval" INTEGER NOT NULL DEFAULT 60,
            "resendInterval" INTEGER NOT NULL DEFAULT 0,
            "upsideDown" BOOLEAN NOT NULL DEFAULT false,
            "description" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            "createdById" TEXT,
            "lastCheckAt" DATETIME,
            "nextCheckAt" DATETIME,
            "lastStatus" INTEGER,
            CONSTRAINT "Monitor_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
          );
        `);
      }

      if (!await hasTable('MonitorStatus')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "MonitorStatus" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "monitorId" TEXT NOT NULL,
            "status" INTEGER NOT NULL,
            "message" TEXT,
            "ping" INTEGER,
            "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "MonitorStatus_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
          );
          
          CREATE INDEX "MonitorStatus_monitorId_timestamp_idx" ON "MonitorStatus"("monitorId", "timestamp");
        `);
      }
    }
  },
  {
    version: 5,
    name: '通知渠道表',
    requiredTables: ['NotificationChannel'],
    check: async () => {
      return await hasTable('NotificationChannel');
    },
    upgrade: async () => {
      if (!await hasTable('NotificationChannel')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "NotificationChannel" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "name" TEXT NOT NULL,
            "type" TEXT NOT NULL,
            "enabled" BOOLEAN NOT NULL DEFAULT true,
            "config" JSONB NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
          );
        `);
      }
    }
  },
  {
    version: 6,
    name: '监控通知关联表',
    requiredTables: ['MonitorNotification'],
    check: async () => {
      return await hasTable('MonitorNotification');
    },
    upgrade: async () => {
      if (!await hasTable('MonitorNotification')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "MonitorNotification" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "monitorId" TEXT NOT NULL,
            "notificationChannelId" TEXT NOT NULL,
            "enabled" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "MonitorNotification_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "MonitorNotification_notificationChannelId_fkey" FOREIGN KEY ("notificationChannelId") REFERENCES "NotificationChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
          );
          
          CREATE INDEX "MonitorNotification_monitorId_idx" ON "MonitorNotification"("monitorId");
          CREATE INDEX "MonitorNotification_notificationChannelId_idx" ON "MonitorNotification"("notificationChannelId");
          CREATE UNIQUE INDEX "MonitorNotification_monitorId_notificationChannelId_key" ON "MonitorNotification"("monitorId", "notificationChannelId");
        `);
      }
    }
  },
  {
    version: 7, // 使用固定版本号
    name: '用户登录记录表',
    requiredTables: ['LoginRecord'],
    check: async () => {
      return await hasTable('LoginRecord');
    },
    upgrade: async () => {
      if (!await hasTable('LoginRecord')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "LoginRecord" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "ipAddress" TEXT,
            "userAgent" TEXT,
            "success" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "LoginRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
          );
          
          CREATE INDEX "LoginRecord_userId_createdAt_idx" ON "LoginRecord"("userId", "createdAt");
        `);
      }
    }
  },
  {
    version: 8,
    name: '状态页功能表',
    requiredTables: ['StatusPage', 'StatusPageMonitor'],
    check: async () => {
      return await hasTable('StatusPage') && await hasTable('StatusPageMonitor');
    },
    upgrade: async () => {
      // 创建StatusPage表
      if (!await hasTable('StatusPage')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "StatusPage" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "name" TEXT NOT NULL,
            "slug" TEXT NOT NULL,
            "title" TEXT NOT NULL,
            "isPublic" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            "createdById" TEXT,
            CONSTRAINT "StatusPage_slug_key" UNIQUE ("slug"),
            CONSTRAINT "StatusPage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
          );
          
          CREATE INDEX "StatusPage_slug_idx" ON "StatusPage"("slug");
        `);
      }

      // 创建StatusPageMonitor表
      if (!await hasTable('StatusPageMonitor')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "StatusPageMonitor" (
            "statusPageId" TEXT NOT NULL,
            "monitorId" TEXT NOT NULL,
            "displayName" TEXT,
            "order" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "StatusPageMonitor_statusPageId_monitorId_pkey" PRIMARY KEY ("statusPageId", "monitorId"),
            CONSTRAINT "StatusPageMonitor_statusPageId_fkey" FOREIGN KEY ("statusPageId") REFERENCES "StatusPage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "StatusPageMonitor_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
          );
          
          CREATE INDEX "StatusPageMonitor_statusPageId_order_idx" ON "StatusPageMonitor"("statusPageId", "order");
        `);
      }
    }
  },
  {
    version: 9,
    name: '监控项排序功能',
    requiredTables: ['Monitor'],
    check: async () => {
      return await hasColumn('Monitor', 'displayOrder');
    },
    upgrade: async () => {
      // 检查displayOrder列是否存在
      if (!await hasColumn('Monitor', 'displayOrder')) {
        // 添加displayOrder列，默认值为NULL（可选字段）
        await prisma.$executeRawUnsafe(`
          ALTER TABLE "Monitor" ADD COLUMN "displayOrder" INTEGER;
        `);
        
        // 为现有监控项设置默认排序值（按创建时间倒序）
        await prisma.$executeRawUnsafe(`
          UPDATE "Monitor" 
          SET "displayOrder" = (
            SELECT COUNT(*) 
            FROM "Monitor" AS m2 
            WHERE m2."createdAt" >= "Monitor"."createdAt"
          ) - 1
          WHERE "displayOrder" IS NULL;
        `);
      }
    }
  },
  {
    version: 10,
    name: '监控分组功能',
    requiredTables: ['MonitorGroup'],
    check: async () => {
      return await hasTable('MonitorGroup') && await hasColumn('Monitor', 'groupId');
    },
    upgrade: async () => {
      // 创建MonitorGroup表
      if (!await hasTable('MonitorGroup')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "MonitorGroup" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "name" TEXT NOT NULL,
            "description" TEXT,
            "color" TEXT,
            "displayOrder" INTEGER,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            "createdById" TEXT,
            CONSTRAINT "MonitorGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
          );
        `);
      }

      // 为Monitor表添加groupId列
      if (!await hasColumn('Monitor', 'groupId')) {
        await prisma.$executeRawUnsafe(`
          ALTER TABLE "Monitor" ADD COLUMN "groupId" TEXT;
        `);
        
        // 添加外键约束
        await prisma.$executeRawUnsafe(`
          CREATE INDEX "Monitor_groupId_idx" ON "Monitor"("groupId");
        `);
      }
    }
  },
  {
    version: 11,
    name: '自定义脚本动作功能',
    requiredTables: ['ScriptAction', 'ScriptExecution'],
    check: async () => {
      return await hasTable('ScriptAction') && await hasTable('ScriptExecution');
    },
    upgrade: async () => {
      // 创建ScriptAction表
      if (!await hasTable('ScriptAction')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "ScriptAction" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "monitorId" TEXT NOT NULL,
            "enabled" BOOLEAN NOT NULL DEFAULT false,
            "script" TEXT NOT NULL DEFAULT '',
            "triggerCondition" TEXT NOT NULL DEFAULT 'both',
            "timeout" INTEGER NOT NULL DEFAULT 30,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "ScriptAction_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
          );

          CREATE UNIQUE INDEX "ScriptAction_monitorId_key" ON "ScriptAction"("monitorId");
          CREATE INDEX "ScriptAction_monitorId_idx" ON "ScriptAction"("monitorId");
        `);
      }

      // 创建ScriptExecution表
      if (!await hasTable('ScriptExecution')) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE "ScriptExecution" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "scriptActionId" TEXT NOT NULL,
            "exitCode" INTEGER,
            "output" TEXT NOT NULL DEFAULT '',
            "durationMs" INTEGER NOT NULL DEFAULT 0,
            "success" BOOLEAN NOT NULL DEFAULT false,
            "timedOut" BOOLEAN NOT NULL DEFAULT false,
            "triggerSource" TEXT NOT NULL DEFAULT 'real',
            "currentStatus" INTEGER NOT NULL,
            "prevStatus" INTEGER,
            "errorMessage" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "ScriptExecution_scriptActionId_fkey" FOREIGN KEY ("scriptActionId") REFERENCES "ScriptAction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
          );

          CREATE INDEX "ScriptExecution_scriptActionId_createdAt_idx" ON "ScriptExecution"("scriptActionId", "createdAt");
          CREATE INDEX "ScriptExecution_createdAt_idx" ON "ScriptExecution"("createdAt");
        `);
      } else if (!await hasIndex('ScriptExecution', 'ScriptExecution_createdAt_idx')) {
        // 表已存在但缺少 createdAt 单列索引（从旧版本升级），补充创建
        await prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS "ScriptExecution_createdAt_idx" ON "ScriptExecution"("createdAt");
        `);
      }
    }
  }
];

// 获取数据库当前版本
export async function getCurrentDbVersion(): Promise<number> {
  try {
    // 先检查SystemConfig表是否存在
    if (!await hasTable('SystemConfig')) {
      // 尝试判断初始数据库版本
      if (await hasTable('User') && await hasTable('Session')) {
        return 1; // 初始版本
      }
      return 0; // 空数据库
    }
    
    try {
      const config = await prisma.systemConfig.findUnique({
        where: { key: 'dbVersion' }
      });
      return config?.value ? parseInt(config.value) : 0;
    } catch (error) {
      console.error('读取数据库版本失败:', error);
      return 0;
    }
  } catch (error) {
    console.error('获取数据库版本失败:', error);
    return 0;
  }
}

// 设置数据库版本
export async function setDbVersion(version: number): Promise<void> {
  try {
    // 确保SystemConfig表存在
    if (!await hasTable('SystemConfig')) {
      await DB_VERSIONS[1].upgrade?.(); // 创建SystemConfig表
    }
    
    await prisma.systemConfig.upsert({
      where: { key: 'dbVersion' },
      update: { value: version.toString(), updatedAt: new Date() },
      create: { 
        key: 'dbVersion', 
        value: version.toString()
      }
    });
    console.log(`数据库版本已更新为: ${version}`);
  } catch (error) {
    console.error('更新数据库版本失败:', error);
    throw error;
  }
}

// 检查表是否存在
async function hasTable(tableName: string): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<{name: string}[]>`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name=${tableName}
    `;
    return result.length > 0;
  } catch (error) {
    console.error(`检查表 ${tableName} 是否存在失败:`, error);
    return false;
  }
}

// 检查列是否存在
async function hasColumn(tableName: string, columnName: string): Promise<boolean> {
  try {
    const result = await prisma.$queryRawUnsafe<{name: string}[]>(
      `PRAGMA table_info("${tableName}")`
    );
    return result.some(col => col.name === columnName);
  } catch (error) {
    console.error(`检查表 ${tableName} 的列 ${columnName} 是否存在失败:`, error);
    return false;
  }
}

// 检查索引是否存在
async function hasIndex(_tableName: string, indexName: string): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<{name: string}[]>`
      SELECT name FROM sqlite_master WHERE type='index' AND name=${indexName}
    `;
    return Array.isArray(result) && result.length > 0;
  } catch (error) {
    console.error(`检查索引 ${indexName} 是否存在失败:`, error);
    return false;
  }
}

// 检查列是否为必需的
async function isColumnRequired(tableName: string, columnName: string): Promise<boolean> {
  try {
    const result = await prisma.$queryRawUnsafe<{name: string, notnull: number}[]>(
      `PRAGMA table_info("${tableName}")`
    );
    const column = result.find(col => col.name === columnName);
    return column ? column.notnull === 1 : false;
  } catch (error) {
    console.error(`检查表 ${tableName} 的列 ${columnName} 是否必需失败:`, error);
    return false;
  }
}

// 备份数据库
export async function backupDatabase(): Promise<string | null> {
  const dbPath = path.resolve(process.cwd(), 'data/coolmonitor.db');
  if (!fs.existsSync(dbPath)) {
    console.log('数据库文件不存在，无需备份');
    return null;
  }
  
  const backupDir = path.resolve(process.cwd(), 'data/backup');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `coolmonitor.db.${timestamp}`);
  
  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log(`数据库已备份至: ${backupPath}`);
    
    // 执行备份清理，只保留最新的3个备份
    cleanupOldBackups(backupDir, 3);
    
    return backupPath;
  } catch (error) {
    console.error('备份数据库失败:', error);
    return null;
  }
}

// 清理旧备份，只保留最新的n个备份
function cleanupOldBackups(backupDir: string, keepCount: number): void {
  try {
    if (!fs.existsSync(backupDir)) {
      return;
    }
    
    // 获取所有备份文件
    const backupFiles = fs.readdirSync(backupDir)
      .filter(file => file.startsWith('coolmonitor.db.'))
      .map(file => ({
        name: file,
        path: path.join(backupDir, file),
        time: fs.statSync(path.join(backupDir, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time); // 按时间降序排列
    
    // 如果备份数量大于保留数量，删除多余的备份
    if (backupFiles.length > keepCount) {
      const filesToDelete = backupFiles.slice(keepCount);
      filesToDelete.forEach(file => {
        try {
          fs.unlinkSync(file.path);
          console.log(`已删除旧备份: ${file.name}`);
        } catch (err) {
          console.error(`删除旧备份失败: ${file.name}`, err);
        }
      });
      console.log(`已清理旧备份，保留最新的${keepCount}个备份文件`);
    }
  } catch (error) {
    console.error('清理旧备份失败:', error);
  }
}

// 执行数据库升级
export async function upgradeDatabaseIfNeeded(): Promise<boolean> {
  try {
    // 检查是否有强制升级标记
    const forcedUpgradePath = path.resolve(process.cwd(), 'data/.db-upgrade-needed');
    let isForceUpgrade = fs.existsSync(forcedUpgradePath);
    
    if (isForceUpgrade) {
      console.log('检测到强制升级标记，将执行完整数据库升级流程');
    }
    
    // 检查所有表是否存在，如果有缺失表，强制执行升级
    let missingTables = false;
    for (const version of DB_VERSIONS) {
      if (version.requiredTables) {
        for (const table of version.requiredTables) {
          if (!await hasTable(table)) {
            console.log(`检测到缺失表: ${table}，将强制执行升级`);
            missingTables = true;
            break;
          }
        }
        if (missingTables) break;
      }
    }
    
    // 如果检测到缺失表或有强制升级标记，设置为强制升级
    isForceUpgrade = isForceUpgrade || missingTables;
    
    // 备份数据库
    await backupDatabase();
    
    // 获取当前版本
    let currentVersion = await getCurrentDbVersion();
    console.log(`当前数据库版本: ${currentVersion}`);
    
    // 获取最新版本
    const latestVersion = DB_VERSIONS.length;
    
    if (currentVersion >= latestVersion && !isForceUpgrade) {
      console.log('数据库已是最新版本');
      return true;
    }
    
    // 是否需要诊断当前版本
    if (currentVersion === 0 || isForceUpgrade) {
      console.log('正在诊断数据库版本...');
      
      // 如果是强制升级，重置版本
      if (isForceUpgrade) {
        currentVersion = 0;
      }
      
      // 尝试确定当前版本
      for (let i = DB_VERSIONS.length - 1; i >= 0; i--) {
        const version = DB_VERSIONS[i];
        if (await version.check()) {
          currentVersion = version.version;
          console.log(`诊断结果：当前数据库版本为 ${currentVersion}`);
          break;
        }
      }
    }
    
    // 执行升级过程
    for (let v = currentVersion + 1; v <= latestVersion; v++) {
      if (v <= 0 || v > DB_VERSIONS.length) continue;
      
      const versionInfo = DB_VERSIONS[v - 1];
      console.log(`正在升级到版本 ${v}: ${versionInfo.name}...`);
      
      // 执行升级脚本
      if (versionInfo.upgrade) {
        try {
          await versionInfo.upgrade();
          
          // 验证升级是否成功
          if (versionInfo.requiredTables) {
            for (const table of versionInfo.requiredTables) {
              const tableExists = await hasTable(table);
              if (!tableExists) {
                console.error(`升级后未检测到表: ${table}，升级可能未完全成功`);
              } else {
                console.log(`表 ${table} 已成功创建`);
              }
            }
          }
          
        } catch (error) {
          console.error(`执行版本 ${v} 升级脚本出错:`, error);
          throw error;
        }
      }
      
      // 更新数据库版本
      await setDbVersion(v);
      
      console.log(`升级到版本 ${v} 完成`);
    }
    
    // 最终验证所有必要的表是否存在
    let allTablesExist = true;
    for (const version of DB_VERSIONS) {
      if (version.requiredTables) {
        for (const table of version.requiredTables) {
          const tableExists = await hasTable(table);
          if (!tableExists) {
            console.error(`升级完成后仍未检测到表: ${table}`);
            allTablesExist = false;
          }
        }
      }
    }
    
    if (!allTablesExist) {
      console.error('数据库升级完成，但有部分表未正确创建，可能需要手动修复');
    } else {
      console.log('所有必要的表已正确创建');
    }
    
    // 移除升级标记文件
    if (isForceUpgrade && fs.existsSync(forcedUpgradePath)) {
      fs.unlinkSync(forcedUpgradePath);
      console.log('已移除强制升级标记');
    }
    
    console.log('数据库升级完成');
    
    // 注意：Prisma客户端不在运行时重新生成，而是应在构建镜像时更新
    if (currentVersion !== latestVersion) {
      console.log('数据库结构已更新');
    }
    
    return true;
  } catch (error) {
    console.error('数据库升级失败:', error);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

// 重置数据库版本（用于调试）
export async function resetDbVersion(): Promise<void> {
  try {
    if (await hasTable('SystemConfig')) {
      await prisma.$executeRawUnsafe(`
        DELETE FROM SystemConfig WHERE key='dbVersion'
      `);
      console.log('数据库版本已重置');
    }
  } catch (error) {
    console.error('重置数据库版本失败:', error);
  }
} 