import os
import json
import click
import git
import re
import time
from github import Github

REMOTE = os.environ.get("ORIGIN", "origin")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")

def bump_version(file_path, version_spec):
    with open(file_path, 'r') as file:
        data = json.load(file)

    current_version = data['version']
    major, minor, patch = map(int, current_version.split('.'))

    if SEMVER_RE.match(version_spec):
        new_version = version_spec
    elif version_spec == 'major':
        major += 1
        minor = 0
        patch = 0
        new_version = f"{major}.{minor}.{patch}"
    elif version_spec == 'minor':
        minor += 1
        patch = 0
        new_version = f"{major}.{minor}.{patch}"
    elif version_spec == 'patch':
        patch += 1
        new_version = f"{major}.{minor}.{patch}"
    elif version_spec == 'force':
        new_version = current_version
    else:
        raise click.BadParameter(
            "Use 'major', 'minor', 'patch', 'force', or an explicit version like '0.8.1'."
        )

    data['version'] = new_version

    with open(file_path, 'w') as file:
        json.dump(data, file, indent=2)

    return new_version

def delete_tag(repo, tag_name):
    try:
        repo.git.push('--delete', REMOTE, tag_name)
    except git.exc.GitCommandError:
        pass
    try:
        repo.delete_tag(tag_name)
    except git.exc.GitCommandError:
        pass

def wait_for_release(github_client, repo_name, tag_name, timeout_seconds=600, interval_seconds=30):
    deadline = time.time() + timeout_seconds
    while True:
        repo = github_client.get_repo(repo_name)
        releases = repo.get_releases()
        release_names = [release.tag_name for release in releases]

        if tag_name in release_names:
            return True

        if time.time() >= deadline:
            return False

        print(f"Release {tag_name} not found yet. Waiting {interval_seconds} seconds...")
        time.sleep(interval_seconds)

@click.command()
@click.argument('version_spec')
def main(version_spec):
    """Create a beta release from a bump type or explicit X.Y.Z version."""
    manifest_file = "manifest-beta.json"
    repo = git.Repo('.')
    g = Github()
    repo_name = "no-instructions/relay"

    new_version = bump_version(manifest_file, version_spec)

    # Delete tags
    delete_tag(repo, new_version)

    # Create a commit for the version bump
    repo.git.add(manifest_file)
    try:
        repo.git.commit(m=f"version: bump the beta version to {new_version}")
    except git.exc.GitCommandError:
        pass

    # Create a new tag
    repo.create_tag(new_version)

    # Push the tag first so GitHub can build the release before the branch
    # advertises the beta manifest version.
    remote = repo.remote(name=REMOTE)
    remote.push(new_version)

    # Wait for GitHub to create the release
    print("Waiting for GitHub to create the release...")
    if not wait_for_release(g, repo_name, new_version):
        raise click.ClickException(f"Release {new_version} not found.")

    print(f"Release {new_version} created successfully.")

    # Push the branch only after the release exists.
    force = (version_spec == 'force')
    repo.git.push(force=force)

if __name__ == "__main__":
    main()
