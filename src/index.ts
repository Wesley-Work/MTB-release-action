import core from "@actions/core";
import cache from "@actions/cache";
import path from "path";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";

// 简单字符串哈希函数
function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

const execAsync = promisify(exec);

async function run() {
  try {
    // 获取输入参数
    const token = core.getInput("token", { required: true });
    const repoName = core.getInput("repoName", { required: true });
    const organization = "Wesley-Work";

    // 初始化GitHub客户端
    const octokit = new Octokit({ auth: token });

    // 获取仓库信息
    core.notice(`Fetching repository ${repoName}...`);
    let repo;
    try {
      const response = await octokit.repos.get({
        owner: organization,
        repo: repoName,
      });
      repo = response.data;
    } catch (error: any) {
      if (error.status === 404) {
        core.setFailed(`Repository ${repoName} not found in organization`);
      } else {
        core.setFailed(`Failed to get repository info: ${error.message}`);
      }
      return;
    }

    // 2. 克隆仓库
    core.notice(`Cloning repository ${repo.clone_url}...`);
    await execAsync(`git clone ${repo.clone_url} ${repoName}`);

    core.info("Checking pnpm availability...");
    try {
      await execAsync("pnpm --version");
    } catch {
      core.info("Installing pnpm...");
      await execAsync("npm install -g pnpm");
    }

    core.notice("Install Dependencies...");
    process.chdir(repoName);

    // 设置缓存
    const cacheKey = `pnpm-store-${process.platform}-${hashCode(fs.readFileSync("pnpm-lock.yaml", "utf8"))}`;
    // 获取pnpm store路径
    const pnpmStorePath = (await execAsync("pnpm store path")).stdout.trim();
    await execAsync(`mkdir -p ${pnpmStorePath}`);

    // 尝试恢复缓存
    const cacheHit = await cache.restoreCache([pnpmStorePath], cacheKey);
    if (cacheHit) {
      core.info(`Cache restored from key: ${cacheKey}`);
    } else {
      core.warning("No cache found, will create new cache after installation");
    }

    // 安装依赖
    await execAsync("pnpm install");

    // 保存缓存
    if (!cacheHit) {
      try {
        await cache.saveCache([pnpmStorePath], cacheKey);
        core.info(`Cache saved with key: ${cacheKey}`);
      } catch (error) {
        core.warning(`Failed to save cache: ${error}`);
      }
    }

    // 进入仓库目录并执行构建
    // 读取package.json并执行所有build脚本
    core.notice("Reading package.json and executing build scripts...");
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    const buildScripts = Object.entries(packageJson.scripts || {})
      .filter(([name]) => name.startsWith("build"))
      .map(([name, script]) => ({ name, script }));

    core.warning(JSON.stringify(buildScripts));

    if (buildScripts.length === 0) {
      core.setFailed("No build: scripts found in package.json");
      return;
    }

    // 获取package.json版本号的函数
    const getPackageVersion = (dir: string = process.cwd()) => {
      const packageJsonPath = path.join(dir, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      return packageJson.version || "0.0.0";
    };

    const zipFiles = [];
    for (const { name, script } of buildScripts) {
      core.notice(`Running build script: ${name} (${script})`);
      await execAsync(`pnpm run ${name}`);

      // 获取版本号
      const version = getPackageVersion();

      const scriptName = name.replace("build:", "");
      const scriptPart = scriptName === "build" ? "" : `-${scriptName}`;

      // 压缩包文件名，REPO_NAME(-MODE)-BuildPackage-VERSION.zip
      const zipFileName = `${repoName.replace("/", "-")}${scriptPart.toUpperCase()}-BuildPackage-${version.replace(/\./g, "_")}.zip`;

      // 使用临时目录避免冲突
      const tempDir = `temp-${scriptName}`;
      await execAsync(`mkdir -p ${tempDir}`);
      await execAsync(`cp -r dist/* ${tempDir}/`);
      await execAsync(`zip -r ../${zipFileName} ${tempDir}`);
      await execAsync(`rm -rf ${tempDir}`);
      zipFiles.push(zipFileName);
    }
    process.chdir("..");

    // 读取目标仓库的CHANGELOG.md文件，获取最新版本日志
    let releaseBody = "";
    try {
      const changelogPath = path.join(process.cwd(), repoName, "CHANGELOG.md");
      if (fs.existsSync(changelogPath)) {
        const changelogContent = fs.readFileSync(changelogPath, "utf8");
        const versionMatch = changelogContent.match(
          /(## 🌈 \d+\.\d+\.\d+ `\d{4}-\d{2}-\d{2}`)\n([\s\S]+?)(?=\n## 🌈 |$)/,
        );
        if (versionMatch) {
          releaseBody = `${versionMatch[1]}\n\n${versionMatch[2].trim()}`;
        }
      }
    } catch (error) {
      core.warning(`Failed to parse CHANGELOG.md: ${error}`);
    }

    // 获取上一个Release的tag
    let compareUrl = "";
    try {
      const releases = await octokit.repos.listReleases({
        owner: organization,
        repo: repoName,
        per_page: 2,
      });

      if (releases.data.length > 1) {
        const previousTag = releases.data[1].tag_name;
        const currentTag = `v${new Date().toISOString().split("T")[0]}`;
        compareUrl = `\n\n[Compare with previous version](https://github.com/${organization}/${repoName}/compare/${previousTag}...${currentTag})`;
      }
    } catch (error) {
      core.warning(`Failed to get previous release: ${error}`);
    }

    // 创建Release并上传所有压缩包
    core.notice("Creating release...");
    // 获取版本号
    const version = getPackageVersion(path.join(process.cwd(), repoName));

    // 获取当前CI运行ID
    const runId = process.env.GITHUB_RUN_ID || "unknown";

    const releaseResponse = await octokit.repos.createRelease({
      owner: organization,
      repo: repoName,
      tag_name: `v${version}`,
      name: `Release v${version}`,
      body: `${releaseBody}\n\nBuilt packages:\n${zipFiles.join("\n")}${compareUrl}\n\n<small>CI Run ID: ${runId}</small>`,
      draft: false,
      prerelease: false,
    });

    // 上传所有压缩包
    for (const zipFile of zipFiles) {
      core.notice(`Uploading release asset: ${zipFile}...`);
      await octokit.repos.uploadReleaseAsset({
        owner: organization,
        repo: repoName,
        release_id: releaseResponse.data.id,
        name: zipFile,
        data: fs.readFileSync(zipFile, "utf8"),
      });
    }

    core.notice("Release created successfully!");
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : "Unknown error occurred",
    );
  }
}

run();
