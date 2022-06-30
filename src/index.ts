import colors from 'picocolors'
import type { Options as ExecaOptions } from 'execa'
import execa from 'execa'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import type { ReleaseType } from 'semver'
import semver from 'semver'
import prompts from 'prompts'
import cac from 'cac'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)

interface ReleaseOptions {
  monorepo?: boolean
  dry?: boolean
  registry?: string
  package?: string[]
}

type ResolvedReleaseOptions = Required<ReleaseOptions>

const cli = cac('release')
const root = path.join(path.basename(import.meta.url), '../')

function getMemoRepoPackages(root: string) {
  return readdirSync(path.resolve(root, './packages/')).filter((pkgPath) => {
    const pkg: { private?: boolean } = _require(
      path.resolve(root, './packages/', pkgPath, 'package.json')
    )
    return !pkg.private
  })
}

function getPackageInfo(pkgName: string, pkgDir: string) {
  if (!existsSync(pkgDir)) {
    throw new Error(`Package ${pkgName} not found`)
  }

  const pkgPath = path.resolve(pkgDir, 'package.json')
  const pkg: {
    name: string
    version: string
    private?: boolean
  } = _require(pkgPath)
  const currentVersion = pkg.version

  return {
    pkg,
    pkgName,
    pkgDir,
    pkgPath,
    currentVersion
  }
}

let run = async (
  bin: string,
  args: string[],
  opts: ExecaOptions<string> = {}
) => execa(bin, args, { stdio: 'inherit', ...opts })

const dryRun = async (
  bin: string,
  args: string[],
  opts?: ExecaOptions<string>
) => console.log(colors.blue(`[dryrun] ${bin} ${args.join(' ')}`), opts || '')

function step(msg: string) {
  return console.log(colors.cyan(msg))
}

function getVersionChoices(currentVersion: string) {
  const currentBeta = currentVersion.includes('beta')

  const inc: (i: ReleaseType) => string = (i) =>
    semver.inc(currentVersion, i, 'beta')!

  const versionChoices = [
    {
      title: 'next',
      value: inc(currentBeta ? 'prerelease' : 'patch')
    },
    ...(currentBeta
      ? [
          {
            title: 'stable',
            value: inc('patch')
          }
        ]
      : [
          {
            title: 'beta-minor',
            value: inc('preminor')
          },
          {
            title: 'beta-major',
            value: inc('premajor')
          },
          {
            title: 'minor',
            value: inc('minor')
          },
          {
            title: 'major',
            value: inc('major')
          }
        ]),
    { value: 'custom', title: 'custom' }
  ].map((i) => {
    i.title = `${i.title} (${i.value})`
    return i
  })

  return versionChoices
}

function updateVersion(pkgPath: string, version: string): void {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

async function publishPackage(
  pkdDir: string,
  tag?: string,
  registry?: string
): Promise<void> {
  const publicArgs = ['publish', '--access', 'public']
  if (tag) {
    publicArgs.push(`--tag`, tag)
  }
  if (registry) {
    publicArgs.push(`--registry`, registry)
  }
  await run('npm', publicArgs, {
    stdio: 'pipe',
    cwd: pkdDir
  })
}

async function getLatestTag(pkgName: string) {
  const tags = (await run('git', ['tag'], { stdio: 'pipe' })).stdout
    .split(/\n/)
    .filter(Boolean)
  const prefix = `${pkgName}@`
  return tags
    .filter((tag) => tag.startsWith(prefix))
    .sort()
    .reverse()[0]
}

async function logRecentCommits(pkgName: string) {
  const tag = await getLatestTag(pkgName)
  if (!tag) return
  const sha = await run('git', ['rev-list', '-n', '1', tag], {
    stdio: 'pipe'
  }).then((res) => res.stdout.trim())
  console.log(
    colors.bold(
      `\n${colors.blue(`i`)} Commits of ${colors.green(
        pkgName
      )} since ${colors.green(tag)} ${colors.gray(`(${sha.slice(0, 5)})`)}`
    )
  )
  await run(
    'git',
    [
      '--no-pager',
      'log',
      `${sha}..HEAD`,
      '--oneline',
      '--',
      `packages/${pkgName}`
    ],
    { stdio: 'inherit' }
  )
  console.log()
}

async function releaseMemoRepo(config: ResolvedReleaseOptions): Promise<void> {
  let targetVersion: string | undefined

  const { monorepo } = config

  let pkg: string
  let pkgDir: string
  if (monorepo) {
    const memoRepoPackages = getMemoRepoPackages(root)

    const input: { pkg: string } = await prompts({
      type: 'select',
      name: 'pkg',
      message: 'Select package',
      choices: memoRepoPackages.map((i) => ({ value: i, title: i }))
    })
    pkg = input.pkg
    pkgDir = path.resolve(root, './packages/', pkg)
  } else {
    const input: { pkg: string } = await prompts({
      type: 'select',
      name: 'pkg',
      message: 'Select package',
      choices: config.package.map((i) => ({ value: i, title: i }))
    })
    pkg = input.pkg
    pkgDir = path.resolve(root)
  }

  if (!pkg) return

  await logRecentCommits(pkg)

  const { currentVersion, pkgName, pkgPath } = getPackageInfo(pkg, pkgDir)

  if (!targetVersion) {
    const { release }: { release: string } = await prompts({
      type: 'select',
      name: 'release',
      message: 'Select release type',
      choices: getVersionChoices(currentVersion)
    })

    if (release === 'custom') {
      const res: { version: string } = await prompts({
        type: 'text',
        name: 'version',
        message: 'Input custom version',
        initial: currentVersion
      })
      targetVersion = res.version
    } else {
      targetVersion = release
    }
  }

  if (!semver.valid(targetVersion)) {
    throw new Error(`invalid target version: ${targetVersion}`)
  }

  const tag = `${pkgName}@${targetVersion}`

  const { yes }: { yes: boolean } = await prompts({
    type: 'confirm',
    name: 'yes',
    message: `Releasing ${colors.yellow(tag)} Confirm?`
  })

  if (!yes) {
    return
  }

  step('\nUpdating package version...')
  updateVersion(pkgPath, targetVersion)

  // step('\nGenerating changelog...')
  // const changelogArgs = [
  //   'conventional-changelog',
  //   '-p',
  //   'angular',
  //   '-i',
  //   'CHANGELOG.md',
  //   '-s',
  //   '--commit-path',
  //   '.'
  // ]

  // await run('npx', changelogArgs, { cwd: pkgDir })

  const { stdout } = await run('git', ['diff'], { stdio: 'pipe' })
  if (stdout) {
    step('\nCommitting changes...')
    await run('git', ['add', '-A'])
    await run('git', ['commit', '-m', `release: ${tag}`])
    await run('git', ['tag', tag])
  } else {
    console.log('No changes to commit.')
    return
  }

  step('\nPushing to GitHub...')
  await run('git', ['push', 'origin', `refs/tags/${tag}`])
  await run('git', ['push'])

  if (config.dry) {
    console.log(`\nDry run finished - run git diff to see package changes.`)
  } else {
    console.log(
      colors.green('\nPushed, publishing should starts shortly on CI.\n')
    )
  }

  console.log()
}

async function publishCI(tag: string, config: ResolvedReleaseOptions) {
  let [pkgName, version] = tag.split('@', 2)

  if (version.startsWith('v')) version = version.slice(1)
  const pkgDir = config.monorepo
    ? path.resolve(root, 'packages', pkgName)
    : path.resolve(root)
  const { currentVersion } = getPackageInfo(pkgName, pkgDir)
  if (currentVersion !== version)
    throw new Error(
      `Package version from tag "${version}" mismatches with current version "${currentVersion}"`
    )

  step('Publishing package...')
  await publishPackage(
    pkgDir,
    version.includes('beta') ? 'beta' : undefined,
    config.registry
  )
}

function resolveOptions(raw: ReleaseOptions): ResolvedReleaseOptions {
  return {
    monorepo: raw.monorepo ?? false,
    dry: raw.dry || false,
    registry: raw.registry || 'https://registry.npmjs.org/',
    package: (typeof raw.package === 'string'
      ? [raw.package]
      : raw.package || []
    ).concat(['all'])
  }
}

cli
  .command('')
  .option('--monorepo', '[boolean] release memo repo')
  .option(
    '--package [...package]',
    '[string[]] no monorepo release select packages'
  )
  .option('--dry', '[boolean] dry to run')
  .action((options: ReleaseOptions) => {
    const releaseConfig = resolveOptions(options)
    if (releaseConfig.dry) {
      run = dryRun as any
    }
    releaseMemoRepo(releaseConfig)
  })

cli
  .command('publish [tag]')
  .option('--monorepo', '[boolean] release memo repo')
  .option('--dry', '[boolean] dry to run')
  .option('--registry <registry>', '[string] registry to publish to')
  .action((tag: string, options: ReleaseOptions) => {
    const releaseConfig = resolveOptions(options)
    if (releaseConfig.dry) {
      run = dryRun as any
    }
    publishCI(tag, releaseConfig)
  })

cli.parse()
