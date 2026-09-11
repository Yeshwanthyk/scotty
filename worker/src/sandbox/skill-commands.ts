export interface SyncedSkillCommandInput {
  readonly name: string;
  readonly source: string;
}

export interface SkillLinkPaths {
  readonly merged: string;
  readonly codexSkills: string;
  readonly piSkills: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const skillLinkCommand = (target: string, source: string): string =>
  `{ [ ! -e ${shellQuote(target)} ] || [ "$(readlink ${shellQuote(target)})" = ${shellQuote(source)} ]; } && ln -sfn ${shellQuote(source)} ${shellQuote(target)}`;

export const buildMergedSkillsCommand = (
  paths: SkillLinkPaths,
  skills: ReadonlyArray<SyncedSkillCommandInput>,
): string => {
  const parts = [`mkdir -p ${shellQuote(paths.merged)}`];
  for (const skill of skills)
    parts.push(skillLinkCommand(`${paths.merged}/${skill.name}`, skill.source));
  parts.push(`ln -sfn ${shellQuote(paths.merged)} ${shellQuote(paths.codexSkills)}`);
  parts.push(`ln -sfn ${shellQuote(paths.merged)} ${shellQuote(paths.piSkills)}`);
  return parts.join(" && ");
};

export const buildSkillsPreflightCommands = (
  merged: string,
  skills: ReadonlyArray<Pick<SyncedSkillCommandInput, "name">>,
): ReadonlyArray<string> =>
  skills.map((skill) => `test -e ${shellQuote(`${merged}/${skill.name}`)}`);
