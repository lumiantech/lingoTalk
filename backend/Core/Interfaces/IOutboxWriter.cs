namespace Core.Interfaces;

public interface IOutboxWriter
{
    void Enqueue(
        string type,
        string aggregateId,
        object payload);
}