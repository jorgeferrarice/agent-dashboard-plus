"""Agent profile loader for the Host Daemon.

Loads agent tool profiles from YAML/JSON files in the
profiles/ directory. Each profile defines how to spawn,
detect, and monitor a specific agent tool (e.g. Claude
Code, Gemini CLI, Bash).

Profiles are loaded once at daemon startup and used
throughout the daemon's lifecycle to drive tool-specific
behavior without hardcoded if/elif branches.
"""

import glob
import json
import os
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional

import yaml


@dataclass
class CommandConfig:
    """Spawn command configuration for an agent tool."""

    new: List[str] = field(default_factory=list)
    resume: List[str] = field(default_factory=list)


@dataclass
class AuthConfig:
    """Authentication detection configuration."""

    env_vars: List[str] = field(default_factory=list)
    require: str = "any"


@dataclass
class McpConfig:
    """MCP server detection configuration."""

    project_file: Optional[str] = None
    user_files: List[str] = field(default_factory=list)


@dataclass
class RuntimeMetric:
    """Runtime duration metric configuration."""

    name: str = ""
    unit: str = "seconds"


@dataclass
class TelemetryConfig:
    """OTLP telemetry metric mapping configuration."""

    token_metrics: List[str] = field(default_factory=list)
    cost_metric: Optional[str] = None
    activity_metrics: List[str] = field(default_factory=list)
    runtime_metric: Optional[RuntimeMetric] = None
    excluded_metrics: List[str] = field(default_factory=list)


@dataclass
class SidecarConfig:
    """Sidecar telemetry configuration (e.g. bash
    PROMPT_COMMAND).
    """

    prompt_command: Optional[str] = None
    file_pattern: str = "{tmpdir}/.agent-telemetry-{agent_id}"
    fields: Dict[str, str] = field(default_factory=dict)


@dataclass
class ModelsConfig:
    """Model picker configuration for tools whose model is
    chosen per session (e.g. a routing gateway's combos).

    The daemon offers ``static`` names plus whatever
    ``list_url`` returns, and exports the chosen name to
    the agent process as the ``model_env`` variable.
    """

    # Variable the chosen model is exported as.
    model_env: str = ""
    # Model used when the session request names none.
    default: str = ""
    # Names always offered, without a network call.
    static: List[str] = field(default_factory=list)
    # Optional HTTP endpoint returning more names as JSON.
    list_url: Optional[str] = None
    # Profile env key holding the Bearer token for list_url.
    auth_env: Optional[str] = None


@dataclass
class ConfigDirsConfig:
    """Where a tool keeps its per-account configuration.

    A tool that can be pointed at another configuration
    directory by an environment variable can run several
    accounts side by side. The daemon looks for such
    directories and offers each one as its own tool (a
    "variant" of the profile).

    Attributes:
        env: Variable that selects the directory, e.g.
            ``CLAUDE_CONFIG_DIR``.
        glob: Pattern matching candidate directories, e.g.
            ``~/.claude*``.
        default: Directory the tool uses when ``env`` is not
            set. It belongs to the profile itself, not to a
            variant.
        login_file: File, relative to a directory, that exists
            once an account is signed in there.
        default_login_file: Path of that file for ``default``,
            when the tool keeps it elsewhere. Defaults to
            ``login_file`` inside ``default``.
        login_key: When set, ``login_file`` is JSON and only
            counts as a login if it has this top-level key.
        aliases: Old tool names, mapped to the variant name
            that replaced them, so existing sessions resume.
    """

    env: str = ""
    glob: str = ""
    default: str = ""
    login_file: str = ""
    default_login_file: str = ""
    login_key: str = ""
    aliases: Dict[str, str] = field(default_factory=dict)


@dataclass
class UsageConfig:
    """How to read a tool's subscription limits.

    A profile with this section is a tool that has plan
    limits. ``parser`` names the reader for its screen (see
    ``agent/usage_probe.py``); left empty, the tool has limits
    but no way to read them, and the UI says "unavailable".

    Attributes:
        parser: Name of the screen reader: ``claude``,
            ``codex``, or "" for none.
        keys: What to type to bring the limits up.
        command: Command that opens the tool. Defaults to the
            profile's ``commands.new``.
        prompts: Start-up questions to answer before typing.
            Each is ``{match: <text on screen>, keys: [<tmux
            key names>]}`` and is answered once.
    """

    parser: str = ""
    keys: str = ""
    command: List[str] = field(default_factory=list)
    prompts: List[dict] = field(default_factory=list)


@dataclass
class MountConfig:
    """Volume mount for container run."""

    host: str = ""
    container: str = ""
    mode: str = "rw"


@dataclass
class ConfigFileConfig:
    """Config file to seed in the container image."""

    path: str = ""
    mkdir: bool = False
    content: Optional[str] = None


@dataclass
class InstallConfig:
    """Package installation by method."""

    npm: List[str] = field(default_factory=list)
    pip: List[str] = field(default_factory=list)
    system: List[str] = field(default_factory=list)


@dataclass
class ProvisioningConfig:
    """Build-time provisioning metadata.

    Describes how to install the agent tool in the
    container image, what config files to seed, what
    host directories to mount, and what env vars to
    pass through. Used by the Containerfile generator
    and as documentation for manual setup.
    """

    install: InstallConfig = field(default_factory=InstallConfig)
    config_files: List[ConfigFileConfig] = field(default_factory=list)
    verify: Optional[str] = None
    mounts: List[MountConfig] = field(default_factory=list)
    passthrough_env: List[str] = field(default_factory=list)


@dataclass
class AgentProfile:
    """Complete profile for an agent tool.

    Defines all tool-specific behavior: how to spawn it,
    what env vars it needs, where its MCP configs live,
    what OTLP metrics it emits, how to detect if it's
    installed, and what permission prompts it uses.
    """

    name: str = ""
    display_name: str = ""
    color: str = ""
    binary: str = ""
    always_available: bool = False
    commands: CommandConfig = field(default_factory=CommandConfig)
    env: Dict[str, str] = field(default_factory=dict)
    auth: AuthConfig = field(default_factory=AuthConfig)
    mcp: Optional[McpConfig] = None
    telemetry: TelemetryConfig = field(default_factory=TelemetryConfig)
    sidecar: Optional[SidecarConfig] = None
    permission_patterns: List[str] = field(default_factory=list)
    spawn_settings: Dict[str, Dict[str, object]] = field(default_factory=dict)
    provisioning: Optional[ProvisioningConfig] = None
    models: Optional[ModelsConfig] = None
    config_dirs: Optional[ConfigDirsConfig] = None
    usage: Optional[UsageConfig] = None

    @property
    def is_variant(self) -> bool:
        """Whether this profile is a discovered variant: one
        that runs the tool against a non-default configuration
        directory.
        """
        return bool(self.config_dirs and self.config_dirs.env in self.env)

    @property
    def supports_resume(self) -> bool:
        """Whether the tool supports resuming a previous
        session. True when the resume command is defined
        and differs from the new-session command.
        """
        return bool(self.commands.resume) and self.commands.resume != self.commands.new


def _parse_profile(data: dict) -> AgentProfile:
    """Parses a raw dict (from YAML/JSON) into an
    AgentProfile dataclass.

    Args:
        data: Raw profile dict from yaml.safe_load().

    Returns:
        Populated AgentProfile instance.
    """
    profile = AgentProfile(
        name=data.get("name", ""),
        display_name=data.get("display_name", ""),
        color=data.get("color", ""),
        binary=data.get("binary", ""),
        always_available=data.get("always_available", False),
        permission_patterns=data.get("permission_patterns", []),
        env=data.get("env", {}),
    )

    # Commands
    cmds = data.get("commands", {})
    profile.commands = CommandConfig(
        new=cmds.get("new", []),
        resume=cmds.get("resume", []),
    )

    # Auth
    auth = data.get("auth", {})
    profile.auth = AuthConfig(
        env_vars=auth.get("env_vars", []),
        require=auth.get("require", "any"),
    )

    # MCP
    mcp = data.get("mcp")
    if mcp:
        profile.mcp = McpConfig(
            project_file=mcp.get("project_file"),
            user_files=mcp.get("user_files", []),
        )

    # Telemetry
    tel = data.get("telemetry", {})
    runtime = tel.get("runtime_metric")
    profile.telemetry = TelemetryConfig(
        token_metrics=tel.get("token_metrics", []),
        cost_metric=tel.get("cost_metric"),
        activity_metrics=tel.get("activity_metrics", []),
        runtime_metric=(
            RuntimeMetric(
                name=runtime.get("name", ""),
                unit=runtime.get("unit", "seconds"),
            )
            if runtime
            else None
        ),
        excluded_metrics=tel.get("excluded_metrics", []),
    )

    # Sidecar
    sc = data.get("sidecar")
    if sc:
        profile.sidecar = SidecarConfig(
            prompt_command=sc.get("prompt_command"),
            file_pattern=sc.get(
                "file_pattern",
                "{tmpdir}/.agent-telemetry-{agent_id}",
            ),
            fields=sc.get("fields", {}),
        )

    # Provisioning
    prov = data.get("provisioning")
    if prov:
        inst = prov.get("install", {})
        profile.provisioning = ProvisioningConfig(
            install=InstallConfig(
                npm=inst.get("npm", []),
                pip=inst.get("pip", []),
                system=inst.get("system", []),
            ),
            config_files=[
                ConfigFileConfig(
                    path=cf.get("path", ""),
                    mkdir=cf.get("mkdir", False),
                    content=cf.get("content"),
                )
                for cf in prov.get("config_files", [])
            ],
            verify=prov.get("verify"),
            mounts=[
                MountConfig(
                    host=m.get("host", ""),
                    container=m.get("container", ""),
                    mode=m.get("mode", "rw"),
                )
                for m in prov.get("mounts", [])
            ],
            passthrough_env=prov.get("passthrough_env", []),
        )

    # Spawn settings — JSON files to patch at spawn time
    profile.spawn_settings = data.get("spawn_settings", {})

    # Per-session model picker
    models = data.get("models")
    if models:
        profile.models = ModelsConfig(
            model_env=models.get("model_env", ""),
            default=models.get("default", ""),
            static=models.get("static", []),
            list_url=models.get("list_url"),
            auth_env=models.get("auth_env"),
        )

    # Subscription limits
    usage = data.get("usage")
    if usage is not None:
        usage = usage or {}
        profile.usage = UsageConfig(
            parser=usage.get("parser", ""),
            keys=usage.get("keys", ""),
            command=usage.get("command") or [],
            prompts=usage.get("prompts") or [],
        )

    # Per-account configuration directories
    dirs = data.get("config_dirs")
    if dirs:
        profile.config_dirs = ConfigDirsConfig(
            env=dirs.get("env", ""),
            glob=dirs.get("glob", ""),
            default=dirs.get("default", ""),
            login_file=dirs.get("login_file", ""),
            default_login_file=dirs.get("default_login_file", ""),
            login_key=dirs.get("login_key", ""),
            aliases=dirs.get("aliases") or {},
        )

    return profile


def _has_login(path: str, key: str) -> bool:
    """Tells whether a login file shows a signed-in account.

    Only the presence of the file, or of one key in it, is
    looked at. Its contents are never returned or logged.

    Args:
        path: Path of the login file.
        key: Top-level JSON key that must be present, or ""
            when the file existing is enough.

    Returns:
        True if an account is signed in.
    """
    if not os.path.isfile(path):
        return False
    if not key:
        return True
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and bool(data.get(key))


def profile_logged_in(profile: AgentProfile) -> bool:
    """Best-effort check that a tool is ready to use.

    A tool counts as signed in when its required auth
    variables are set and, for tools with a known login file,
    that file shows an account. Tools the daemon knows nothing
    about are assumed ready. A credential passed through the
    environment (API key, cloud project) also counts, as the
    login file is only one of the ways to authenticate.

    Args:
        profile: The profile, or variant, to check.

    Returns:
        False only when the daemon can tell a login is missing.
    """
    try:
        wanted = profile.auth.env_vars
        if wanted:
            check = all if profile.auth.require == "all" else any
            if not check(os.getenv(v) for v in wanted):
                return False
        cfg = profile.config_dirs
        if not cfg or not cfg.login_file:
            return True
        passthrough = (
            profile.provisioning.passthrough_env if profile.provisioning else []
        )
        if any(os.getenv(v) for v in passthrough):
            return True
        chosen = profile.env.get(cfg.env) if cfg.env else None
        if chosen:
            path = os.path.join(chosen, cfg.login_file)
        else:
            path = os.path.expanduser(
                cfg.default_login_file or os.path.join(cfg.default, cfg.login_file)
            )
        return _has_login(path, cfg.login_key)
    except Exception as e:  # pylint: disable=broad-exception-caught
        # A check that cannot run must not hide the tool.
        print(f"Login check failed for {profile.name}: {e}")
        return True


def discover_variants(profile: AgentProfile) -> List[AgentProfile]:
    """Finds the extra accounts a tool is set up with.

    Every directory matching the profile's ``config_dirs.glob``
    that has a signed-in account, other than the default one,
    becomes a variant: a copy of the profile that runs the tool
    with ``config_dirs.env`` pointing at that directory. The
    variant is named after the directory, e.g.
    ``~/.claude-work`` gives ``claude-work``.

    Args:
        profile: A base profile. Variants yield nothing.

    Returns:
        The variants, ordered by directory name. Empty when the
        profile has no ``config_dirs`` or nothing matches.
    """
    cfg = profile.config_dirs
    if not cfg or not cfg.env or not cfg.glob or profile.is_variant:
        return []
    variants = []
    try:
        default = os.path.realpath(os.path.expanduser(cfg.default))
        default_login = cfg.default_login_file or os.path.join(
            cfg.default, cfg.login_file
        )
        for path in sorted(glob.glob(os.path.expanduser(cfg.glob))):
            if not os.path.isdir(path) or os.path.realpath(path) == default:
                continue
            login = os.path.join(path, cfg.login_file)
            if cfg.login_file and not _has_login(login, cfg.login_key):
                continue
            # "~/.claude-work" -> "work"; an unrelated name
            # is kept whole.
            base = os.path.basename(path).lstrip(".")
            suffix = (
                base[len(profile.name) :] if base.startswith(profile.name) else base
            )
            suffix = suffix.strip("-_. ") or base

            def moved(ref: str, _path=path, _login=login) -> str:
                """Points a path of the default account at
                this variant's directory."""
                if ref == default_login:
                    return _login
                if cfg.default and ref.startswith(cfg.default + "/"):
                    return _path + ref[len(cfg.default) :]
                return ref

            variants.append(
                replace(
                    profile,
                    name=f"{profile.name}-{suffix}",
                    display_name=f"{profile.display_name} ({suffix})",
                    env={**profile.env, cfg.env: path},
                    mcp=(
                        replace(
                            profile.mcp,
                            user_files=[moved(f) for f in profile.mcp.user_files],
                        )
                        if profile.mcp
                        else None
                    ),
                    spawn_settings={
                        moved(k): v for k, v in profile.spawn_settings.items()
                    },
                )
            )
    except OSError as e:
        print(f"Could not look for {profile.name} accounts: {e}")
    return variants


# Keys whose values are dicts that should be merged
# (local overrides base keys, base keys preserved).
_DICT_MERGE_KEYS = {"env"}

# Keys whose values are lists that should be extended
# (local items appended, duplicates removed).
_LIST_EXTEND_KEYS = {"permission_patterns"}

# Nested paths for dict-merge and list-extend behavior
# inside sub-objects. Each tuple is
# (parent_key, child_key, merge_type).
_NESTED_MERGE = [
    ("commands", None, "dict"),
    ("auth", None, "dict"),
    ("telemetry", "token_metrics", "list"),
    ("telemetry", "activity_metrics", "list"),
    ("telemetry", "excluded_metrics", "list"),
    ("mcp", "user_files", "list"),
    ("sidecar", "fields", "dict"),
    ("provisioning", "passthrough_env", "list"),
]


def _merge_profile_data(base: dict, override: dict) -> dict:
    """Deep-merges a local override dict into a base
    profile dict.

    Merge semantics by field type:
    - Top-level dicts (env): local keys override base
      keys; base-only keys are preserved.
    - Top-level lists (permission_patterns): local items
      are appended; duplicates removed.
    - Nested dicts (commands, auth, sidecar.fields):
      same dict-merge as top-level.
    - Nested lists (telemetry.token_metrics,
      mcp.user_files, provisioning.passthrough_env):
      same list-extend as top-level.
    - Scalars (binary, color, display_name, etc.):
      local value replaces base.
    - The 'name' field is never overridden — it is used
      for matching only.

    Args:
        base: The base profile dict from the tracked
            YAML file.
        override: The local override dict from the
            .local.yaml companion file.

    Returns:
        A new merged dict. Neither input is modified.
    """
    # Collect parent keys from _NESTED_MERGE so we
    # know which top-level keys need dict-merge at the
    # parent level (not scalar replacement).
    _nested_parents = {nm[0] for nm in _NESTED_MERGE}

    merged = dict(base)

    for key, value in override.items():
        # Never override the profile name — it's used
        # for matching the local file to its base.
        if key == "name":
            continue

        if key in _DICT_MERGE_KEYS and isinstance(value, dict):
            base_dict = merged.get(key, {})
            if isinstance(base_dict, dict):
                merged[key] = {**base_dict, **value}
            else:
                merged[key] = value
        elif key in _LIST_EXTEND_KEYS and isinstance(value, list):
            base_list = merged.get(key, [])
            if isinstance(base_list, list):
                combined = list(base_list)
                for item in value:
                    if item not in combined:
                        combined.append(item)
                merged[key] = combined
            else:
                merged[key] = value
        elif key in _nested_parents and isinstance(value, dict):
            # Sub-objects with nested merge rules get
            # dict-merged at the parent level first so
            # base-only keys (like mcp.project_file)
            # are preserved. Child-level merge rules
            # are applied below.
            base_obj = merged.get(key)
            if isinstance(base_obj, dict):
                merged[key] = {**base_obj, **value}
            else:
                merged[key] = value
        else:
            merged[key] = value

    # Apply child-level merge rules within sub-objects
    # that exist in both base and override.
    for parent, child, merge_type in _NESTED_MERGE:
        if parent not in override or child is None:
            continue
        override_parent = override[parent]
        if not isinstance(override_parent, dict):
            continue
        if child not in override_parent:
            continue
        base_parent = base.get(parent)
        if not isinstance(base_parent, dict):
            continue

        # Work on the already-merged parent dict.
        merged_parent = dict(merged.get(parent, {}))

        if merge_type == "list":
            base_list = base_parent.get(child, [])
            override_list = override_parent.get(child, [])
            if isinstance(base_list, list) and isinstance(override_list, list):
                combined = list(base_list)
                for item in override_list:
                    if item not in combined:
                        combined.append(item)
                merged_parent[child] = combined
        elif merge_type == "dict":
            base_dict = base_parent.get(child, {})
            override_dict = override_parent.get(child, {})
            if isinstance(base_dict, dict) and isinstance(override_dict, dict):
                merged_parent[child] = {
                    **base_dict,
                    **override_dict,
                }

        merged[parent] = merged_parent

    return merged


def _find_local_override(directory: str, base_name: str) -> Optional[str]:
    """Finds a .local.yaml/.local.yml/.local.json
    companion file for a base profile.

    Args:
        directory: Path to the profiles directory.
        base_name: Base filename without extension
            (e.g. 'pi' from 'pi.yaml').

    Returns:
        Full path to the local override file, or None.
    """
    for ext in (".local.yaml", ".local.yml", ".local.json"):
        path = os.path.join(directory, base_name + ext)
        if os.path.isfile(path):
            return path
    return None


def _is_local_override(filename: str) -> bool:
    """Returns True if the filename is a .local override
    file (e.g. 'pi.local.yaml'). These are processed
    separately after their base profile is loaded.
    """
    return ".local." in filename


def load_profiles(
    directory: str = None,
) -> Dict[str, AgentProfile]:
    """Loads all agent profiles from a directory.

    Reads all .yaml, .yml, and .json files from the
    specified directory and parses them into AgentProfile
    instances. After loading each base profile, checks
    for a companion .local.yaml/.local.yml/.local.json
    file and deep-merges it into the profile.

    Local override files (*.local.yaml) are gitignored
    and allow environment-specific customizations
    without modifying tracked profile files.

    Args:
        directory: Path to the profiles directory.
            Defaults to agent/profiles/ relative to this
            file.

    Returns:
        Dict mapping profile name to AgentProfile.
    """
    if directory is None:
        directory = os.path.join(os.path.dirname(__file__), "profiles")

    profiles = {}
    if not os.path.isdir(directory):
        print(f"Profiles directory not found: {directory}")
        return profiles

    for filename in sorted(os.listdir(directory)):
        if not filename.endswith((".yaml", ".yml", ".json")):
            continue
        # Skip .local override files — they are merged
        # into their base profile below.
        if _is_local_override(filename):
            continue
        filepath = os.path.join(directory, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            if not data or not isinstance(data, dict):
                print(f"Skipping empty profile: {filename}")
                continue

            # Check for a .local companion file and
            # merge it into the base profile data
            # before parsing.
            base_name = filename.rsplit(".", 1)[0]
            local_path = _find_local_override(directory, base_name)
            if local_path:
                try:
                    with open(local_path, "r", encoding="utf-8") as lf:
                        local_data = yaml.safe_load(lf)
                    if local_data and isinstance(local_data, dict):
                        data = _merge_profile_data(data, local_data)
                        local_name = os.path.basename(local_path)
                        print(f"Merged local overrides: " f"{local_name}")
                except Exception as e:
                    local_name = os.path.basename(local_path)
                    print(f"Error loading local override " f"{local_name}: {e}")

            profile = _parse_profile(data)
            if not profile.name:
                print(f"Profile missing 'name' field: " f"{filename}")
                continue
            profiles[profile.name] = profile
            print(f"Loaded agent profile: {profile.name} " f"({profile.display_name})")
        except Exception as e:
            print(f"Error loading profile {filename}: {e}")

    return profiles
