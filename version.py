import os
import json
import click
import git
import time
from github import Github

REMOTE = os.environ.get("ORIGIN", "origin")

def bump_version(file_path, version_type):
    with open(file_path, 'r') as file:
        data = json.load(file)

    current_version = data['version']
    major, minor, patch = map(int, current_version.split('.'))

    if version_type == 'major':
        major += 1
        minor = 0
        patch = 0
    elif version_type == 'minor':
        minor += 1
        patch = 0
    elif version_type == 'patch':
        patch += 1
    elif version_type == 'force':
        pass
    else:
        raise ValueError("Invalid version type. Use 'major', 'minor', 'patch', or 'force'.")

    new_version = f"{major}.{minor}.{patch}"
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

def github_client():
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    return Github(token) if token else Github()

def wait_for_release(github_client, repo_name, tag_name, timeout_seconds=600, interval_seconds=30):
    deadline = time.time() + timeout_seconds
    while True:
        repo = github_client.get_repo(repo_name)
        releases = repo.get_releases()
        for release in releases:
            if release.tag_name == tag_name:
                return release

        if time.time() >= deadline:
            return None

        print(f"Release {tag_name} not found yet. Waiting {interval_seconds} seconds...")
        time.sleep(interval_seconds)

@click.command()
@click.argument('version_type')
def main(version_type):
    manifest_file = "manifest.json"
    repo = git.Repo('.')
    g = github_client()
    repo_name = "no-instructions/relay"

    new_version = bump_version(manifest_file, version_type)

    # Delete tags
    delete_tag(repo, new_version)

    # Create a commit for the version bump
    repo.git.add(manifest_file)
    try:
        repo.git.commit(m=f"version: bump the version to {new_version}")
    except git.exc.GitCommandError:
        pass

    # Create a new tag
    repo.create_tag(new_version)

    # Push the new tag
    remote = repo.remote(name=REMOTE)
    remote.push(new_version)

    # Wait for GitHub to create the release
    print("Waiting for GitHub to create the release...")
    release = wait_for_release(g, repo_name, new_version)
    if not release:
        raise click.ClickException(f"Release {new_version} not found.")

    print(f"Release {new_version} created successfully.")
    if getattr(release, "html_url", None):
        print(release.html_url)

if __name__ == "__main__":
    main()
