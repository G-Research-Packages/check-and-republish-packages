const core = require('@actions/core');
const github = require('@actions/github');
const {graphql} = require('@octokit/graphql');
const fetch = require('node-fetch');
const fs = require('fs');
const fsp = require('fs').promises;
const { Octokit } = require("@octokit/rest");
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const streamPipeline = util.promisify(require('stream').pipeline);
 
const dockerHost = 'docker.pkg.github.com'
 
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
 
async function setUpNuget(thisOwner, packagePushUser, packagePushToken) {
    await fsp.writeFile('nuget.config', `<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <packageSources>
        <clear />
        <add key="github" value="https://nuget.pkg.github.com/${thisOwner}/index.json" />
    </packageSources>
    <packageSourceCredentials>
        <github>
            <add key="Username" value="${packagePushUser}" />
            <add key="ClearTextPassword" value="${packagePushToken}" />
        </github>
    </packageSourceCredentials>
</configuration>`);
}
 
async function setUpDocker(thisOwner, packagePushUser, packagePushToken) {
    const passwordFilename = 'docker.password'
    await fsp.writeFile(passwordFilename, packagePushToken);
    await exec('cat ' + passwordFilename + ' | docker login ' + dockerHost + ' --username ' + packagePushUser + ' --password-stdin');
}
 
async function getExistingReleases(thisOwner, thisRepo, packagePushToken) {
    const releasesQuery = `
    {
      repository(owner: "${thisOwner}", name: "${thisRepo}") {
        releases(first: 100 orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes {
                name,
                tagName
                } 
            }
        }
    }`
    
    const {repository: {releases: {nodes: releaseNodes}} } = await graphql(releasesQuery, {headers: {authorization: 'token ' + packagePushToken}});
    var existingReleases = [];
    for (releaseNode of releaseNodes) {
        console.log('Found existing release with name ' + releaseNode.name + ' and tag ' + releaseNode.tagName);
        existingReleases.push(releaseNode.name + '_' + releaseNode.tagName);
    }
 
    return existingReleases;
}
 
async function getExistingPackages(thisOwner, thisRepo, packagePushToken) {
    var existingPackages = [];
    
   const packageNodes = await octokit.rest.packages.listPackagesForOrganization({ "container", thisOwner}); 
   for (packageNode of packageNodes) {
        console.log('Got a package: ' + packageNode.name);
        const packageVersions = await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg("container", packageNode.name, thisOwner);
        for (versionNode of packageVersions) {
            console.log('Found existing package version ' + packageNode.name + ' ' + versionNode.metadata.container.tags + ' with type ' + versionNode.metadata.package_type);
            if (packageNode.packageType == 'NUGET') {
                existingPackages.push(packageNode.name + '.' + versionNode.version + '.nupkg');
            } else if (packageNode.package_type == 'container') {
                existingPackages.push(packageNode.name + '_' + versionNode.metadata.container.tags + '.docker.tar.gz');
            }
        }
    }
    return existingPackages;
}

function packageNameToReleaseAndTagName(packageName)
{
    const nameParts = packageName.split('_');
 
    if (nameParts.length != 3) {
        core.setFailed('Package name should be in the format <release name>_<tag>_[.extension]: Found ' + packageName);
                return '';
            }
    return nameParts[0] + '_' + nameParts[1];
}
 
async function uploadNugetPackage(thisOwner, thisRepo, packageName) {
    console.log('- Unpacking NuGet package');
    const extractedDir = packageName + '.extracted';
    await exec('unzip ' + packageName + ' -d ' + extractedDir);
 
    const filesInPackage = await fsp.readdir(extractedDir);
    const nuspecFilename = filesInPackage.find(filename => filename.endsWith('nuspec'));
    if (!nuspecFilename) {
        core.setFailed('Couldn\'t find .nuspec file in Nuget package');
        return;
    }
    
    console.log('- Updating ' + nuspecFilename + ' to reference this repository (required for GitHub package upload to succeed)');
    await exec('chmod 700 ' + extractedDir + '/' + nuspecFilename);
    const lines = (await fsp.readFile(extractedDir + '/' + nuspecFilename)).toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const newLine = lines[i].replace(/repository url="[^"]*"/, 'repository url="https://github.com/' + thisOwner + '/' + thisRepo + '"');
        if (newLine != lines[i]) {
            console.log('- ' + lines[i] + ' -> ' + newLine.trim());
            lines[i] = newLine;
        } else {
            console.log('- ' + lines[i]);
        }
    }
    await fsp.writeFile(extractedDir + '/' + nuspecFilename, lines.join('\n'));
    await exec('zip -j ' + packageName + ' ' + extractedDir + '/' + nuspecFilename);
 
    console.log('- Uploading NuGet package to https://github.com/' + thisOwner);
    await exec('dotnet nuget push ' + packageName + ' --source "github"');
    console.log('- Uploaded ' + packageName);
}
 
async function uploadAsRelease(thisOwner, thisRepo, packageName, octokit) {
    const nameParts = packageName.split('_');
 
    if (nameParts.length != 3) {
        core.setFailed('Package name should be in the format <release name>_<tag>_[.extension]: Found ' + packageName);
                return;
            }
    
    const releaseName = nameParts[0];
    const releaseTag = nameParts[1];
    console.log('- Release name extracted from filename: ' + releaseName);
    console.log('- Release tag extracted from filename: ' + releaseTag);
 
    const {data: {id: id, upload_url: uploadUrl}} = await octokit.request('POST /repos/{owner}/{repo}/releases', {
        owner: thisOwner,
        repo: thisRepo,
        tag_name: releaseTag,
        target_commitish: 'main',
        name: releaseName,
        body: 'Uploaded by HI build process',
        draft: false,
        prerelease: false,
        generate_release_notes: false
      })

      const size = fs.statSync(packageName).size;
 
      await octokit.request({
        name: releaseName,
        label: packageName,
        data: fs.createReadStream(packageName),
        method: "POST",
        url: uploadUrl,
        headers: {
            "content-type": "text/json",
            "content-length": size
        }
      })
}

async function uploadDockerImage(thisOwner, thisRepo, packageName) {
    console.log('- Uploading docker image from ' + packageName);
 
    const repoTagGuessedFromFileName = packageName.replace('.docker.tar.gz', '').replace('_', ':');
    await exec('zcat ' + packageName + ' | docker load > docker_load_output');
    await exec('grep "Loaded image" docker_load_output | cut -d" " -f 3 > loaded_repotag');
 
    // Artifact name needs to match naming convention. Otherwise we'd have to download artifacts to get the tag to tell if they'd already been uploaded as packages.
    const tag = await fsp.readFile("loaded_repotag");
    console.log('Confirming repo/tag in file ' + tag + ' consistent with repo/tag guessed from filename ' + repoTagGuessedFromFileName);
    await exec('echo Confirming repo/tag in file $(cat loaded_repotag) consistent with repo/tag guessed from filename ' + repoTagGuessedFromFileName + ' && [ "$(cat loaded_repotag | rev | cut -d/ -f 1 | rev)" = "' + repoTagGuessedFromFileName + '" ]');
 
    const newTag = (dockerHost + '/' + thisOwner + '/' + thisRepo + '/' + repoTagGuessedFromFileName).toLowerCase();
 
    console.log('Will retag ' + tag + ' as ' + newTag + ' then push');
  
    const options = {};
    options.cwd = './lib';
 
    await exec('docker tag $(cat loaded_repotag) ' + newTag + ' > dockerlog.txt 2>&1');
    await exec('docker push ' + newTag + ' > dockerlog.txt 2>&1');
    const dockerOutput = await fsp.readFile("dockerlog.txt");
    console.log("Docker operations output: " + dockerOutput);
}
 
(async () => {
    try {
        const sourceOwner = core.getInput('source-owner');
        const sourceRepoWorkflowBranches = core.getInput('source-repo-workflow-branches').split(',').map(b => b.trim());
        const sourceToken = core.getInput('source-token');
        const packagePushUser = core.getInput('package-push-user');
        const packagePushToken = core.getInput('package-push-token');
        const thisOwner = process.env['GITHUB_REPOSITORY'].split('/')[0];
        const thisRepo = process.env['GITHUB_REPOSITORY'].split('/')[1];
        const publishAsRelease = core.getInput('publish-as-release') == 'true';
        const octokit = github.getOctokit(sourceToken);
 
        console.log('Starting with parameters sourceOwner=' + sourceOwner + ' packagePushUser=' + packagePushUser + ' thisOwner/thisRepo=' + thisOwner + '/' + thisRepo + ' publishAsRelease=' + publishAsRelease)
 
        await setUpNuget(thisOwner, packagePushUser, packagePushToken);
        await setUpDocker(thisOwner, packagePushUser, packagePushToken);
 
        const existingPackages = await getExistingPackages(thisOwner, thisRepo, packagePushToken);
        const existingReleases = await getExistingReleases(thisOwner, thisRepo, packagePushToken);
        
        var thresholdDate = new Date();
        thresholdDate.setHours(thresholdDate.getHours() - 12);
 
        for (sourceRepoWorkflowBranch of sourceRepoWorkflowBranches) {
            const parts = sourceRepoWorkflowBranch.split('/');
            if (parts.length != 3) {
                core.setFailed('source-repo-workflow-branches should be a comma-separated list of repo/workflow/branch: Found ' + sourceRepoWorkflowBranch);
                continue;
            }
            const sourceRepo = parts[0];
            const workflowName = parts[1];
            const permittedBranch = parts[2];
 
            console.log('Looking for workflows named "' + workflowName + '" in ' + sourceOwner + '/' + sourceRepo);
            const {data: {workflows}} = await octokit.actions.listRepoWorkflows({owner: sourceOwner, repo: sourceRepo});
 
            const workflow = workflows.find(workflow => workflow.name == workflowName);
            if (!workflow) {
                core.setFailed('Failed to find workflow "' + workflowName + '" in ' + sourceOwner + '/' + sourceRepo);
                continue;
            }
            console.log('Found workflow with id ' + workflow.id + ' name ' + workflow.name + ' url ' + workflow.html_url);
 
            console.log('Looking for runs of that workflow on branch ' + permittedBranch);
            const {data: {workflow_runs: workflowRuns}} = await octokit.actions.listWorkflowRuns({owner: sourceOwner, repo: sourceRepo, workflow_id: workflow.id, branch: permittedBranch});
            const recentWorkflowRuns = workflowRuns.filter(workflowRun => new Date(workflowRun.updated_at).getTime() > thresholdDate.getTime());
            console.log('Found ' + workflowRuns.length + ' workflow run(s) in total. Of these, ' + recentWorkflowRuns.length + ' were updated after ' + thresholdDate.toISOString() + ', the rest will be ignored.');
 
            for (workflowRun of recentWorkflowRuns) {
                console.log('Checking workflow run number ' + workflowRun.run_number + ' (url ' + workflowRun.html_url + ',  updated at ' + workflowRun.updated_at + ')');
                const {data: {artifacts: artifacts}} = await octokit.actions.listWorkflowRunArtifacts({owner: sourceOwner, repo: sourceRepo, run_id: workflowRun.id});
                const {data: {jobs}} = await octokit.actions.listJobsForWorkflowRun({owner: sourceOwner, repo: sourceRepo, run_id: workflowRun.id});
                for (job of jobs) {
                    if (job.status != 'completed') {
                        console.log(job.name + ': ' + job.status);
                        continue;
                    }
                    
                    const {data: log} = await octokit.actions.downloadJobLogsForWorkflowRun({owner: sourceOwner, repo: sourceRepo, job_id: job.id});
                    const logLines = log.split(/\r?\n/)
 
                    var packagesPublishedByJob = [];
                    for (logLine of logLines) {
                        const match = logLine.match(/--- Uploaded package ([^ ]+) as a GitHub artifact \(SHA256: ([^ ]+)\) ---/)
                        if (match != null) {
                            const package = {name: match[1], sha: match[2]}
                            if (!packagesPublishedByJob.find(p => p.name == package.name)) {
                                packagesPublishedByJob.push(package);
                            }
                        }
                    }
                    console.log(job.name + ': ' + job.status + ', published ' + packagesPublishedByJob.length + ' package(s):');
                 
                    
                    for (package of packagesPublishedByJob) {
                        if (publishAsRelease && existingReleases.includes(packageNameToReleaseAndTagName(package.name)) ||
                            !publishAsRelease && existingPackages.includes(package.name)) {
                            console.log(package.name + ' [' + package.sha + ']: Already republished');
                            continue;
                        }
 
                        const artifact = artifacts.find(artifact => artifact.name == package.name);
                        if (!artifact) {
                            core.setFailed(package.name + '[' + package.sha + ']: No artifact with that name uploaded by workflow run');
                            continue;
                        }
 
                        console.log('Resolving download URL for artifact ' + artifact.id + ' from ' + sourceOwner + '/' + sourceRepo);
                        const { headers: { location: artifactDownloadUrl } } = await octokit.request(artifact.url + '/zip', { request: { redirect: 'manual' } });
 
                        console.log('Downloading artifact ' + artifact.id + ' from ' + sourceOwner + '/' + sourceRepo);
                        const downloadResponse = await fetch(artifactDownloadUrl);
                        if (!downloadResponse.ok) {
                            core.setFailed('Unable to download artifact ' + artifact.id + ' from ' + sourceOwner + '/' + sourceRepo + ': Unexpected response ' + downloadResponse.statusText);
                            continue;
                        }
                        await streamPipeline(downloadResponse.body, fs.createWriteStream(package.name + '.zip'));
 
                        console.log('Unzipping');
                        await exec('unzip -o ' + package.name + '.zip && rm -f ' + package.name + '.zip');
 
                        console.log('Confirming sha256');
                        const {stdout} = await exec('sha256sum ' + package.name);
                        const sha256 = stdout.slice(0, 64);
                        if (package.sha != sha256) {
                            core.setFailed(package.name + '[' + package.sha + ']: Found artifact with non-matching SHA256 ' + sha256);
                            continue;
                        }
                        
                        console.log(package.name + ' [' + package.sha + ']: Downloaded artifact, SHA256 matches, republishing:');
                        if (publishAsRelease) {
                            await uploadAsRelease(thisOwner, thisRepo, package.name, octokit);
                        } else if (package.name.endsWith('.nupkg')) {
                            await uploadNugetPackage(thisOwner, thisRepo, package.name);
                        } else if (package.name.endsWith('.docker.tar.gz')) {
                            await uploadDockerImage(thisOwner, thisRepo, package.name);
                        } else {
                            core.setFailed('Package type not currently supported');
                        }
                    }
                }
            }
        }
    } catch (error) {
        core.setFailed(error.message);
    }
})();
