#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID = 0 ]] || exit 78
source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
guard=/opt/kairos-sandbox/bin/cluster-command.py
secrets_directory=/var/lib/kairos-sandbox/secrets
"$guard" identity
"$guard" kubectl apply -f "$source_directory/prerequisites.yaml"
"$guard" kubectl create secret tls registry-tls -n kairos-registry \
  --cert="$secrets_directory/registry.crt" --key="$secrets_directory/registry.key"
"$guard" kubectl create secret generic registry-auth -n kairos-registry \
  --from-file=htpasswd="$secrets_directory/htpasswd"
"$guard" kubectl create secret generic snapshot-push -n opensandbox \
  --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$secrets_directory/registry-dockerconfig.json"
"$guard" kubectl create secret generic snapshot-pull -n opensandbox \
  --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$secrets_directory/registry-dockerconfig.json"
"$guard" kubectl create configmap snapshot-registry-ca -n opensandbox \
  --from-file=ca.crt="$secrets_directory/registry-ca.crt"
"$guard" kubectl create secret generic opensandbox-api-key -n opensandbox-system \
  --from-file=api-key="$secrets_directory/api-key"
"$guard" kubectl create secret generic sandbox-route-keys -n opensandbox-system \
  --from-file=keys="$secrets_directory/route.keys" --from-file=active-key="$secrets_directory/route.active-key"
"$guard" kubectl create configmap kairos-sandbox-template -n opensandbox-system \
  --from-file=sandbox-template.yaml="$source_directory/sandbox-template.yaml"
"$guard" kubectl rollout status deployment/snapshot-registry -n kairos-registry --timeout=90s
