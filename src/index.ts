import * as core from "@actions/core";
import * as github from "@actions/github";
import path from "path";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

async function run() {
  try {
    // 获取输入参数
    const token = core.getInput("token", { required: true });
    const repoName = core.getInput("repoName", { required: true });
    const organization = "Wesley-Work";

    // 初始化GitHub客户端
    const octokit = new Octokit({ auth: token });

    // 1. 获取仓库信息
    core.info(`Fetching repository ${repoName}...`);
    let repo;
    // log
    core.info(JSON.stringify(repoName));
    try {
      const response = await octokit.repos.get({
        owner: organization,
        repo: repoName,
      });
      repo = response.data;
      // log
      core.info(JSON.stringify(response));
    } catch (error: any) {
      if (error.status === 404) {
        core.setFailed(`Repository ${repoName} not found in organization`);
      } else {
        core.setFailed(`Failed to get repository info: ${error.message}`);
      }
      return;
    }

    // 2. 克隆仓库
    core.info(`Cloning repository ${repo.clone_url}...`);
    await execAsync(`git clone ${repo.clone_url} ${repoName}`);

    core.info("Checking pnpm availability...");
    try {
      await execAsync("pnpm --version");
    } catch {
      core.info("Installing pnpm...");
      await execAsync("npm install -g pnpm");
    }

    // 3. 进入仓库目录并执行构建
    core.info("Building the project...");
    process.chdir(repoName);
    await execAsync("pnpm install && pnpm build");

    // 4. 读取package.json并执行所有build:脚本
    core.info("Reading package.json and executing build scripts...");
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    const buildScripts = Object.entries(packageJson.scripts || {})
      .filter(([name]) => name.startsWith("build:"))
      .map(([name, script]) => ({ name, script }));

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
      const scriptName = name.replace("build:", "");
      core.info(`Running build script: ${name} (${script})`);
      await execAsync(script as string);

      // 获取版本号
      const version = getPackageVersion();

      // 生成zip文件名
      const scriptPart = scriptName === "build" ? "" : `-${scriptName}`;
      const zipFileName = `${repoName.replace("/", "-")}${scriptPart}-BuildPackage-${version}.zip`;

      // 使用临时目录避免冲突
      const tempDir = `temp-${scriptName}`;
      await execAsync(`mkdir -p ${tempDir}`);
      await execAsync(`cp -r dist/* ${tempDir}/`);
      await execAsync(`zip -r ../${zipFileName} ${tempDir}`);
      await execAsync(`rm -rf ${tempDir}`);
      zipFiles.push(zipFileName);
    }
    process.chdir("..");

    // 5. 读取CHANGELOG.md获取最新版本日志
    let releaseBody = "Automated release created by MTB Release Action";
    try {
      const changelogPath = path.join(process.cwd(), repoName, "CHANGELOG.md");
      if (fs.existsSync(changelogPath)) {
        const changelogContent = fs.readFileSync(changelogPath, "utf8");
        const versionSections = changelogContent.split(
          /## 🌈 .+? `\d{4}-\d{2}-\d{2}`/,
        );
        if (versionSections.length > 1) {
          releaseBody = versionSections[1].trim();
        }
      }
    } catch (error) {
      core.warning(`Failed to parse CHANGELOG.md: ${error}`);
    }

    // 6. 获取上一个Release的tag
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

    // 7. 创建Release并上传所有压缩包
    core.info("Creating release...");
    // 获取版本号
    const version = getPackageVersion(path.join(process.cwd(), repoName));

    const releaseResponse = await octokit.repos.createRelease({
      owner: organization,
      repo: repoName,
      tag_name: `v${version}`,
      name: `Release v${version}`,
      body: `${releaseBody}\n\nBuilt packages:\n${zipFiles.join("\n")}${compareUrl}`,
      draft: false,
      prerelease: false,
    });

    // 上传所有压缩包
    for (const zipFile of zipFiles) {
      core.info(`Uploading release asset: ${zipFile}...`);
      await octokit.repos.uploadReleaseAsset({
        owner: organization,
        repo: repoName,
        release_id: releaseResponse.data.id,
        name: zipFile,
        data: fs.readFileSync(zipFile, "utf8"),
      });
    }

    core.info("Release created successfully!");
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : "Unknown error occurred",
    );
  }
}

run();
