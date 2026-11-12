ARG KAIROS_BASE_IMAGE=docker.io/library/node:26.4.0-bookworm-slim@sha256:70a832c538c185e6a1a5387d46fc5b615363c50d49dcf50505879ee3f39c6001
FROM ${KAIROS_BASE_IMAGE}

USER root
ARG DEBIAN_MIRROR=http://deb.debian.org
COPY packages.txt /tmp/kairos-tool-packages.txt
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && xargs apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends < /tmp/kairos-tool-packages.txt \
    && mkdir -p /usr/local/share/kairos \
    && dpkg-query -W -f='${Package}\t${Version}\n' | sort > /usr/local/share/kairos/packages.tsv \
    && rm -rf /var/lib/apt/lists/* /tmp/kairos-tool-packages.txt
COPY verify-tools.sh /usr/local/bin/kairos-verify-tools
RUN chmod 0755 /usr/local/bin/kairos-verify-tools

USER 1000:1000
WORKDIR /workspace
RUN kairos-verify-tools
