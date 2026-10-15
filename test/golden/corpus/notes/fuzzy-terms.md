# Configuration Vocabulary

The configurator reads layered configuration files and lets operators reconfigure a running node.

## Orchestration

The kubernetes operator watches the custom resource and reconciles replicas.

## Serialization

Serializer, deserializer and serialisation helpers live in the codec package. The identifier `parseConfigBlob` handles legacy payloads.
