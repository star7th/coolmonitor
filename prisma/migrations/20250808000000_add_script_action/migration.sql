-- CreateTable
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

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "ScriptAction_monitorId_key" ON "ScriptAction"("monitorId");

-- CreateIndex
CREATE INDEX "ScriptAction_monitorId_idx" ON "ScriptAction"("monitorId");

-- CreateIndex
CREATE INDEX "ScriptExecution_scriptActionId_createdAt_idx" ON "ScriptExecution"("scriptActionId", "createdAt");

-- CreateIndex
CREATE INDEX "ScriptExecution_createdAt_idx" ON "ScriptExecution"("createdAt");
